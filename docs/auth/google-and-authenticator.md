# Google login and Google Authenticator

Enable `server: { auth: true }` in `toil.config.ts`. Both features use the existing
`/auth/me`, `@auth`, session revocation, account deletion, and custom `@user` codec.
Google login is an additional identity provider; its signature security is Google's
RS256, rather than the post-quantum password protocol.

## Google sign-in

Create a Web application client in [Google Cloud](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
Register your production HTTPS origin and your localhost development origin as
Authorized JavaScript origins. Configure branding/consent and publish the consent
screen as appropriate. This implementation uses the GIS JavaScript credential
callback; it does not need a client secret or redirect URI.

Applications can disable Google routes or all second-factor setup routes using
[`server.authRoutes`](./configuration.md#restrict-built-in-auth-routes). Disabling
setup blocks email and authenticator changes together while keeping existing
factors required at sign-in.

```dotenv
# .env (and the tenant's plain environment on toil-backend)
AUTH_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
PUBLIC_BASE_URL=https://your-site.example
```

Run `toiljs generate auth` to configure the auth secrets. Google login and TOTP
require an explicitly configured `AUTH_SESSION_SECRET` of at least 32 characters
in `.env.secrets` (or the tenant secure environment). Never expose it to Vite.
Keep it stable across workers and deployments. Rotating it invalidates sessions,
pending Google nonces, and existing encrypted authenticator secrets.
With only the client ID, only the session secret, or a secret shorter than 32
characters, Google initialization and login return the generic 401 response
without setting cookies or accessing accounts.

Render the official button:

```tsx
import { GoogleSignIn, Auth, TwoFactorRequiredError } from 'toiljs/client';

<GoogleSignIn
    onSuccess={() => { location.assign('/account'); }}
    onError={error => {
        if (error instanceof TwoFactorRequiredError) {
            // Show your code form; save error.twoFaId for Auth.verifyTwoFactor.
        } else {
            // Show a retry action. Never log the credential.
        }
    }}
/>
```

Render one widget at a time. The button initializes a browser-bound nonce valid for
120 seconds; remount it to retry after expiry, cancellation, or a failed attempt.
For your own GIS UI, use `Auth.googleLoginStart()`, initialize GIS with the returned
`clientId` and `nonce`, then pass the callback's `credential` to
`Auth.loginWithGoogle(credential)`. Complete a second-factor challenge using
`Auth.verifyTwoFactor(error.twoFaId, code)`. No session is issued before that succeeds.

Google's SDK needs explicit [CSP allowances](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#content_security_policy).
Add these to `client.cspSources` (merge with existing settings):

```ts
coop: 'same-origin-allow-popups',
cspSources: {
    'connect-src': ['https://accounts.google.com/gsi/'],
    'frame-src': ['https://accounts.google.com/gsi/'],
    'style-src': ['https://accounts.google.com/gsi/style'],
    // Google's current library uses DOM sinks that do not support Trusted Types.
    // This opt-out applies to the whole page; keep Toil's CSP script protections.
    'require-trusted-types-for': [],
}
```

Toil's default script CSP trusts scripts intentionally loaded by `Toil.Script`,
which the component uses. If you override `script-src`, also authorize
`https://accounts.google.com/gsi/client` and your application scripts. The component
requests the FedCM button flow. For browsers using Google's popup fallback, serve
the login page with `Cross-Origin-Opener-Policy: same-origin-allow-popups`. The
`client.coop` option above configures development, Node production, and generated
static-host headers. Apply `build/client/_headers` on other hosts and remove any
conflicting proxy COOP header.
See [Google's setup guidance](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid#cross_origin_opener_policy).

The server validates the RS256 signature, issuer, audience, authorized party,
expiration, issue time, optional not-before time, verified email, and nonce before account access. Google
`sub` determines identity; an email match never links an existing password account.
If the address is already reserved by another account, sign-in fails. The internal
`google_` username prefix is reserved. A changed Google email does not change your
existing Toil account's email or identity. Users can delete their account through
the existing account API. Account linking is not currently exposed. Email password reset does not create a
password credential for Google-only accounts; recover access through Google.

Google is authoritative for Gmail addresses and verified Workspace addresses
with an `hd` claim. A third-party address without `hd` stays unconfirmed until
an independent email confirmation succeeds. When the tenant requires email
confirmation, Google login returns `EmailNotConfirmedError`, sends the initial
confirmation email, and issues no session; `Auth.resendConfirmation(email)`
resends it. A valid Google identity alone does not prove current ownership of a
recycled third-party mailbox. See [Google's verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).


Node >=24 uses asynchronous key preparation around synchronous Wasm dispatch.
Single and multiple production workers use the same path. toil-backend includes
`google-auth` in default features; custom feature builds must include it. Its
async executor suspends while a bounded two-thread service fetches keys and
verifies signatures; the inline executor waits for the same service. Both hosts fetch keys only from
Google's fixed HTTPS JWKS endpoint, with a bounded shared cache, single-flight
refresh, timeout, and refresh cooldown. No per-login tokeninfo or userinfo request.
Security-state unique lookups read the owning database cell. With multiple cells,
the async host routes these reads directly to the owner; the inline host fails
closed when a security key is not local.

Initialization performs zero DB calls. Invalid claims perform zero account calls.
Returning Google login performs one authoritative account read and conditional
replay update, plus the existing deletion, factor, and session-generation checks.
The account retains at most 16 nonces for its latest Google issue-time second;
older tokens and additional simultaneous logins beyond that limit require retry.
There are no Google state/token rows to expire or scan. New-account creation also
reserves the email and maintains the existing user index and registration hook.

## Google Authenticator (TOTP)

Compatible with Google Authenticator and other RFC 6238 apps: SHA-1, six digits,
30-second periods, and a one-step clock tolerance. Keep server time synchronized.

```ts
// Requires a signed-in session. Show the secret directly or encode URI in a QR
// code locally. Never send it to a third-party QR service or analytics.
const { secret, uri } = await Auth.setupAuthenticator('Your Site', 'user@example.com');
// Display secret or QR(uri), collect the code from the user's app:
await Auth.confirmTwoFactorSetup(code);
// Existing sessions are revoked; sign in again with password or Google + TOTP.
```

`Auth.twoFactorStatus()` returns `Auth.TwoFactorMethod.Authenticator` (`2`) when
enabled. Existing `None` (`0`) and `Email` (`1`) values keep their meanings.
Enrollment is pending until a valid app code confirms it; repeating setup replaces
the pending enrollment. Secrets are AES-256-GCM encrypted in the database and bound
to the tenant and account incarnation. Setup responses use `Cache-Control: no-store`.

On login, catch `TwoFactorRequiredError` and submit the app code using
`Auth.verifyTwoFactor(error.twoFaId, code)`. Codes are rate- and attempt-limited.
A successful code advances a linearizable counter: reusing the same or an older
30-second code fails even across separate challenges and workers. Wait for the
next code after confirming enrollment or using a code on another device.
Login and current-factor replacement guesses share a cap of five per minute
per account across source IPs and pending challenges. The counter uses one row per enrollment; successful verification costs one
counter read and one compare-and-exchange. Secret verification itself does no DB I/O.

To disable, prove the current authenticator:

```ts
await Auth.setupTwoFactor(Auth.TwoFactorMethod.None);
await Auth.confirmTwoFactorSetup(codeFromCurrentAuthenticator);
```

To replace an authenticator while it is enabled, pass a fresh current code as the
fourth argument to `Auth.setupAuthenticator(issuer, account, options, currentCode)`;
then confirm with the new authenticator. To switch from email 2FA, disable it with
its email code first, sign in again, then enroll TOTP. A session alone cannot
replace an enabled factor. Password reset keeps the second factor enabled.
There is no automatic factor recovery or recovery-code API; applications must
provide their own identity-verified operator recovery process for lost devices.
Back up authenticator accounts before deploying this option.

## Runtime rollout and limits

Deploy the updated toil-backend before new Wasm: the runtime now imports
`google_verify`, `crypto.totp_verify`, and bounded `codec.base64url_*` helpers.
Node builds include the matching implementations. Existing password accounts and
email-factor values retain their layouts; added security fields are append-only.
Session format 3 rejects existing session cookies and older pending challenges,
so users must sign in again. Its generation keys include the normalized Host;
old application code cannot overwrite the new factor state. Existing factors
in `AuthStateDb` remain readable without resetting the database. Upgrade all
application instances before enabling Google login or TOTP; mixed application
versions cannot consistently enforce a newly introduced factor policy.

Factor confirmation atomically commits the policy and session-generation change
in one immutable claim. A failure after that write may leave the client without
a success response, but earlier sessions are already invalid and the new factor
is enforced. Sign in again to determine the resulting state.

The native integration gate exercises Google registration, authenticator setup,
and two-factor login with the default 128M gas budget. Custom `@user` codecs,
longer domains, concurrent revocations, and application registration hooks can
require additional headroom; configure `TOIL_LIMIT_GAS_HTTP` for the measured
workload. Keep database budgets enabled when testing. No database scans or
per-login Google token/state rows are used.
