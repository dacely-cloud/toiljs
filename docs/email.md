# Email

toiljs can send transactional email from a route handler. A handler calls
`EmailService.send(...)` (or a typed `EmailTemplate` / `Emails.*` from the
`emails/` folder, or the stateless `TwoFactor` helper); the edge hands the
message to a single off-core mailer thread that talks to the provider over the
kernel network (never the worker cores), and **suspends** the wasm call until the
provider responds — so a slow send never blocks the worker.

Everything here is an ambient **global** (no import), like `crypto` and
`AuthService`. A tenant that never sends email pulls none of it into its build.

- **`EmailService`** — send one email.
- **`EmailTemplate`** — a reusable template with `{{placeholder}}` substitution
  (plain text and/or HTML).
- **`emails/*.tsx`** — author emails as React components; the build renders them
  to static HTML and generates a typed `Emails.<Name>.send(...)`.
- **`TwoFactor`** — stateless email verification codes (2FA / confirm), no DB.

> **The one rule of HTML email:** email clients run **no JavaScript** and strip
> `<style>`/external CSS. So HTML email is a static, inline-styled string, and
> any "rendering" (React, CSS files) happens at **build time**, not at send time.
> See [React email templates](#react-email-templates).

## Configure email

Email is a **framework-reserved namespace of the tenant's environment** — the
same out-of-band [Environment](./environment.md) store that backs
`Environment.get` / `getSecure`, but the `[email]` block is **host-only**: it is
read and used in Rust (the off-core mailer) and is **never exposed to the
`.wasm`**. The provider key never lives in the deployed module or in the
inotify-watched `hosts/<host>.toml`.

On the edge today it lives in the tenant's env secrets file,
`$TOIL_ENV_DIR/<host>.env.secrets` (default dir `/run/toil/env`), kept `0600` and
**out of `hosts/`** so the config watcher never sees a credential (the dashboard /
edge DB replaces this file later). Email config is a set of **reserved
`TOIL_EMAIL_*` keys** — host-only, stripped from the guest buckets, so a tenant
can never read them via `Environment.getSecure`:

```bash
# $TOIL_ENV_DIR/<host>.env.secrets   (mode 0600; NOT under hosts/, NOT in the .wasm)

TOIL_EMAIL_ENABLED=true
TOIL_EMAIL_FROM=you@example.com       # validated; single address, no CRLF
TOIL_EMAIL_PROVIDER=resend            # resend | gmail | smtp
TOIL_EMAIL_API_KEY=re_xxxxxxxxxxxx    # the provider credential
TOIL_EMAIL_MAX_PER_MIN=60             # per-tenant send budget
TOIL_EMAIL_MAX_PER_RECIPIENT_PER_HOUR=5   # anti-abuse cap per recipient
```

The same file also carries the tenant's own secrets (and `<host>.env` their plain
vars; see [Environment](./environment.md)); the `TOIL_EMAIL_*` keys are just the
reserved namespace the framework consumes.

When `enabled` is `false` (the default) the host has no email capability and
`EmailService.send` returns `Disabled`. The env is loaded **lazily** (on the
first send) and the `api_key` is materialized into a zeroizing secret in host
memory — never written to logs or `/_admin`. A malformed `[email]` block is
treated as "no email" (the host returns `Disabled`); validate config on the
dashboard before deploying.

### Providers

**Resend** (`provider = "resend"`) — a JSON API; `api_key` holds the API key.

**Gmail** (`TOIL_EMAIL_PROVIDER=gmail`) — SMTP with Gmail defaults:
`smtp.gmail.com`, port `587` (STARTTLS), username = `from`. `TOIL_EMAIL_API_KEY`
holds a Gmail **App Password** (create one at
<https://myaccount.google.com/apppasswords>; the account needs 2-Step
Verification). No extra keys needed:

```bash
TOIL_EMAIL_ENABLED=true
TOIL_EMAIL_FROM=you@gmail.com
TOIL_EMAIL_PROVIDER=gmail
TOIL_EMAIL_API_KEY=abcd efgh ijkl mnop
```

**Generic SMTP** (`TOIL_EMAIL_PROVIDER=smtp`) — any submission server (Outlook,
SendGrid/Mailgun SMTP, your own). Requires `TOIL_EMAIL_SMTP_HOST`; port defaults
to `587` (STARTTLS), or set `465` for implicit TLS. `TOIL_EMAIL_SMTP_USER`
defaults to `from`.

```bash
TOIL_EMAIL_ENABLED=true
TOIL_EMAIL_FROM=noreply@example.com
TOIL_EMAIL_PROVIDER=smtp
TOIL_EMAIL_API_KEY=the-smtp-password
TOIL_EMAIL_SMTP_HOST=smtp.example.com
TOIL_EMAIL_SMTP_PORT=587
TOIL_EMAIL_SMTP_USER=noreply@example.com
```

### In dev

`toiljs dev` has no real provider: `EmailService.send` logs `✉ dev email_send ->
<recipient> (not actually sent)` and returns `Sent`, so your flow proceeds. The
ABI is identical to the edge, so code that runs in dev runs on the edge.

## Sending email

```ts
import { Response, RouteContext } from 'toiljs/server/runtime';

@rest('notify')
class Notify {
    @post('/welcome')
    welcome(ctx: RouteContext): Response {
        const status = EmailService.send(
            'alice@example.com',
            'Welcome!',
            'Thanks for signing up.',   // plain-text body
            'welcome',                  // purpose tag (dedup / abuse keying)
            '<h1>Thanks for signing up.</h1>', // optional HTML body
        );
        return status == EmailStatus.Sent
            ? Response.text('sent\n')
            : Response.text('could not send\n', 503);
    }
}
```

`send(to, subject, body, purpose = 'tx', html = '')` returns an **`EmailStatus`**:

| Status | Meaning | Retry? |
| --- | --- | --- |
| `Sent` | Accepted by the provider | — |
| `Deduped` | An identical recent `(recipient, purpose)` was collapsed | treat as sent |
| `Budget` | The host's per-minute budget is exhausted | yes, later |
| `TryLater` | The mailer was saturated / a queue was full | yes, back off |
| `RecipientCapped` | The per-recipient hourly cap was hit | no (this window) |
| `BadRecipient` | The address failed validation (CRLF, multiple addresses) | no |
| `Disabled` | This host has no `[email]` capability | no |
| `ProviderError` | The provider rejected it, or transport failed after retries | no |

`purpose` is a short, non-PII tag (`"welcome"`, `"reset"`, …). The mailer folds
it into the **dedup** key (identical `(host, recipient, purpose)` within ~30s is
collapsed to one send) and the abuse counters. It is never logged in the clear.

The recipient is validated host-side (exactly one address, no CR/LF/`<>`), so a
guest can never smuggle a second envelope recipient or a header into the send.

## Templates

`EmailTemplate` is a reusable message with `{{placeholder}}` substitution, for
when the same email is sent with different values:

```ts
const welcome = new EmailTemplate(
    'Welcome, {{name}}!',                                  // subject
    'Hi {{name}}, your code is {{code}}.',                 // plain-text body
    '<h1>Welcome, {{name}}</h1><p>Code: <b>{{code}}</b></p>', // html (optional)
);

const vars = new Map<string, string>();
vars.set('name', 'Alice');
vars.set('code', '123456');
const status = welcome.send('alice@example.com', vars, 'welcome');
```

- `{{ name }}` (with surrounding spaces) is accepted; an unknown placeholder
  renders to the empty string.
- Omit the `html` argument for a plain-text template.
- `template.render(vars)` returns the rendered `{ subject, body, html }` without
  sending (useful for preview/testing).

For anything richer than `{{token}}` substitution — real layout, CSS, brand —
author the email as a React component instead.

## React email templates

Write emails as React components in an **`emails/`** folder. At `toiljs build`
each one is rendered **once, at build time**, to static inline-CSS HTML (because
the inbox runs no JS), with the component's props turned into `{{token}}` holes;
the build then generates a typed `Emails.<Name>.send(...)` your server calls.

```tsx
// emails/Welcome.tsx
export const subject = 'Welcome, {{name}}!';

export default function Welcome({ name, code }: { name: string; code: string }) {
    return (
        <table width="100%" style={{ fontFamily: 'Arial, sans-serif' }}>
            <tbody>
                <tr>
                    <td style={{ padding: '24px' }}>
                        <h1 style={{ color: '#111' }}>Welcome, {name}!</h1>
                        <p>Your code is <b>{code}</b>.</p>
                    </td>
                </tr>
            </tbody>
        </table>
    );
}
```

The generated `Emails.Welcome.send(...)` takes the recipient, then one argument
per `{{token}}` **in alphabetical order**, then an optional `purpose`:

```ts
// emails/Welcome.tsx uses {{code}} and {{name}}  ->  params are (code, name)
const status = Emails.Welcome.send('alice@example.com', '123456', 'Alice');
```

Authoring notes:

- **Use inline `style={{ ... }}`.** Email clients strip `<style>`/external CSS;
  inline styles render everywhere. A CSS file imported into the component is
  inlined for you at build (via `juice`).
- **Optional exports:** `export const subject` (a token template; defaults to the
  email name), `export const text` (a plain-text alternative; otherwise derived
  from the HTML), `export const purpose`.
- **Build-time, field substitution only.** Because the component renders once at
  build, per-send data is `{{token}}` substitution — a runtime `{items.map(...)}`
  or conditional bakes in at build, it does not re-run per recipient. That covers
  transactional / 2FA / confirmation email; dynamic lists need a different
  approach.
- The generated `server/_emails.ts` is regenerated on `build`/`dev` and should be
  gitignored.

## Email verification codes (`TwoFactor`)

`TwoFactor` is a **stateless** email-code primitive (2FA, email confirmation,
magic codes) — no database. It emails a random code and returns a signed
**token** that commits to the code via HMAC, without putting the code in the
token (the code is only in the email). Verification recomputes the HMAC from the
token plus the user-entered code, so a valid `(token, code)` pair can only come
from someone who both received the email and holds the token.

```ts
// 1. Issue + email a code; hand `token` to the client (a cookie or hidden field).
const challenge = TwoFactor.send('alice@example.com', 'login'); // emails the code
// challenge.token  -> give to the client
// challenge.status -> the EmailStatus of the send

// 2. Later, verify what the user typed.
const ok: bool = TwoFactor.verify(challenge.token, 'alice@example.com', userEntered);
```

- **`send(recipient, purpose, ttlSecs = 600, digits = 6)`** — issues a code,
  emails it with a built-in template, returns `{ token, status }`.
- **`issue(recipient, purpose, ttlSecs, digits)`** — returns `{ code, token }`
  **without** sending, so you can email `code` with your own `EmailTemplate` /
  `Emails.*` for a branded message.
- **`verify(token, recipient, code)`** — `true` only for a code issued for that
  recipient that hasn't expired. Constant-time compare.
- **`TwoFactor.setSecret(secret)`** — the HMAC secret for the tokens. Call once
  at startup in `main.ts`; it must be identical on every edge instance and out of
  any client bundle. (This is separate from the provider `api_key`.)

**Limitation:** this gives integrity + expiry but **not single-use** — a valid
code verifies repeatedly within its TTL, because there is no server state to burn
it. Keep the TTL short; for true single-use, store a per-recipient
last-verified-at and reject at or before it.

## Limits and abuse controls

All enforced authoritatively in the single mailer (so the counts are exact across
all workers):

- **Per-tenant budget** — `max_per_min` (a token bucket). Over it → `Budget`.
- **Per-recipient cap** — `max_per_recipient_per_hour`. Over it →
  `RecipientCapped`.
- **Dedup** — identical `(host, recipient, purpose)` within ~30s → `Deduped`.

Editing these in the host config takes effect on the next send (no restart).

## Observability

`GET /_admin/email` returns process-wide counters by reason (JSON), e.g.
`submitted`, `sent`, `deduped`, `budget`, `recipient_capped`, `try_later`,
`bad_recipient`, `provider_error`. It exposes **counts only** — never a
recipient, code, subject, body, or secret.

## See also

- [Rate limiting](./ratelimit.md) — protect your routes (including any email
  trigger) with `@ratelimit`.
- [Web Crypto](./crypto.md) — the `crypto` global `TwoFactor` builds on.
