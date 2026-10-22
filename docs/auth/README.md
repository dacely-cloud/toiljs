# Authentication

Toil ships a complete, **post-quantum password login** you turn on with one line. No passwords on your
server, no third-party identity provider, no hand-written crypto: enable it and you get a `/auth/*` API,
signed sessions, `@auth`-guarded routes, and a stable per-user identity.

```ts
// toil.config.ts
import { defineConfig } from 'toiljs/compiler';

export default defineConfig({
    server: { auth: true }, // ← mounts the full /auth/* API + sessions
});
```

That is the whole setup. The build appends the framework's auth controller to your server, so `/auth/*`
is live and `@auth` works everywhere.

For [Google sign-in and Google Authenticator](./google-and-authenticator.md), see the setup,
browser component, production configuration, and TOTP enrollment guide.

## Storage and request lifetime

Authentication uses collections in two databases: `AuthDb` for accounts and
challenges, and `AuthStateDb` for revoked sessions, user generations, and two-factor
settings. Verification is cached only on the current request object. Later requests
check revocation state again; local revocation and signing-secret changes invalidate
the cached result. Temporary failures reading revocations, generations, or
two-factor state abort the request; they never mean that a restriction is absent.

Session generations use immutable revocation claims and a conditional head update.
Reads probe at most eight revisions beyond the head. Revocation claims include
a random ownership nonce so separate revocations cannot coalesce as identical
unique owners. A factor change stores the new factor policy in the same claim
that advances the generation: request failure cannot leave an enabled factor
with still-valid earlier sessions. A competing advance triggers a fresh scan;
ordinary revocations preserve the factor policy. A successful fast claim leaves
a single revision for the next writable request to repair. Writable requests repair a
stale head without overwriting a concurrent advance; read-only queries never
repair it. If a chain exceeds the probe limit, verification fails closed with
`Session state recovering; retry`. A writable sign-in or revocation attempt still
persists its scanned progress before failing, so repeated attempts recover even
chains longer than 64 revisions. No sessions are minted from a partial scan.
Authentication calls count against the same database budget as your handler;
see [database limits](../database/documents.md#size-limits-and-file-uploads).

When a generated `@auth` guard returns 401, it clears both the signed session and
readable user cookies, using their HTTP or HTTPS names and attributes. Storage
failures abort verification instead of returning that 401, preserving credentials
for a retry.

Session format 3 uses host-scoped generation keys, even when domains share a
configured `TOIL_AUTH_DOMAIN`. Upgrading signs everyone out and rejects older
pending login/setup challenges. Existing `AuthStateDb` factor records remain
readable; new changes use atomic generation commits. All server instances must
run the updated application before enabling the new authentication features.

For deployments migrating from the earlier separate session and factor database
namespaces, the `AuthStateDb` layout replaces those namespaces. It requires a fresh store or an explicit migration of existing security
state; it does not read the previous namespaces. The Nerva rollout uses a database
reset alongside the application schema change.

## What you get

| Endpoint | Purpose |
| --- | --- |
| `POST /auth/register/start`, `/register/finish` | Create an account (password never leaves the browser) |
| `POST /auth/login/start`, `/login/finish` | Log in; sets a signed session cookie |
| `GET /auth/me` *(`@auth`)* | The current user (`toilUserId` + `username`) |
| `POST /auth/logout` *(`@auth`)* | Clear the session |

Plus, in your own code:

- **`@auth`** on any route (or a whole `@rest` class) → 401 unless there's a valid session.
- **`AuthService.getUser()`** → the typed logged-in user.
- **`AuthService.userId()`** → the stable [`ToilUserId`](./extending.md#toiluserid) (a 256-bit id you can
  key your data on).
- **The client**: `import { Auth } from 'toiljs/client'`, then `Auth.register(username, password)` /
  `Auth.login(username, password)`. It does all the browser-side crypto and talks to `/auth/*` for you.

## A login page in full

```tsx
// client/routes/login.tsx
import { useState } from 'react';
import { Auth } from 'toiljs/client';

export default function Login() {
    const [u, setU] = useState('');
    const [p, setP] = useState('');
    const [msg, setMsg] = useState('');

    const register = async () => {
        try { await Auth.register(u, p); setMsg('registered, now log in'); }
        catch (e) { setMsg(parseError(e)); }
    };
    const login = async () => {
        try { await Auth.login(u, p); setMsg('logged in'); }   // sets the session cookie
        catch (e) { setMsg(parseError(e)); }
    };

    return (
        <main>
            <input value={u} onChange={(e) => setU(e.currentTarget.value)} placeholder="username" />
            <input value={p} type="password" onChange={(e) => setP(e.currentTarget.value)} placeholder="password" />
            <button onClick={register}>Register</button>
            <button onClick={login}>Log in</button>
            <p>{msg}</p>
        </main>
    );
}
```

```ts
// server/routes/Secret.ts, a route only a logged-in user can reach
import { Response } from 'toiljs/server/runtime';

@rest('secret')
class Secret {
    @auth                     // 401 without a valid session
    @get('/')
    public secret(): Response {
        const user = AuthService.getUser()!;      // typed: { toilUserId, username }
        return Response.text('hello ' + user.username + '\n');
    }
}
```

That's a real, production-grade auth system, the password is stretched with Argon2id in the browser into
an ML-DSA-44 key pair, your server only ever stores a public key, and login is a mutually-authenticated
ML-KEM-768 challenge. You didn't write any of it.

## Where to go next

- **[How it works](./how-it-works.md)**: the protocol (OPRF + Argon2id + ML-DSA + ML-KEM), sessions,
  cookies, and the `ToilUserId`, with sequence diagrams.
- **[Usage](./usage.md)**: enabling it, the client API, guarding routes, reading the user, the full wire
  contract of each endpoint.
- **[Configuration](./configuration.md)**: the secrets a deployment MUST set, the audience/domain, tuning
  Argon2id, and the deploy checklist.
- **[Extending & integrating](./extending.md)**: `ToilUserId`, keying your own data on a user, a custom
  user shape / opting out, and the `AuthService` primitive reference.
- **[Customizing the auth emails](./emails.md)**: replace the verification, password-reset, and 2FA
  emails with your own branded React templates by dropping `emails/auth-*.tsx` files.

> **One rule before you ship:** built-in auth runs with **insecure DEV fallback secrets** so it Just Works
> locally. A deployment MUST set `AUTH_SESSION_SECRET`, `AUTH_OPRF_SEED`, and `AUTH_KEM_SK`. See
> [Configuration](./configuration.md).
