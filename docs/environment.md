# Environment variables & secrets

`Environment` gives a tenant **per-app environment variables and secrets**, set
out of band (a dashboard, like GitHub Actions) so the deployed `.wasm` carries
**no credentials**. It is read-only from app code — there is no `set`; values are
configured on the deployment side, never from the module.

```ts
import { Response, RouteContext } from 'toiljs/server/runtime';

@rest('cfg')
class Cfg {
    @get('/')
    show(ctx: RouteContext): Response {
        const base = Environment.get('PUBLIC_API_BASE'); // plain var, or null
        const key = Environment.getSecure('STRIPE_KEY'); // secret, or null
        // Use `key` to call a third party; never log it or return it to a client.
        return Response.text(base != null ? base : 'unset');
    }
}
```

`Environment` is a global — no import needed (like `EmailService` / `AuthService`).

## Two disjoint buckets

Just like GitHub Actions' `vars` vs `secrets`:

- **`Environment.get(key)`** reads **plain vars** — non-sensitive config (a public
  API base URL, a feature flag, a region). Returns the string, or `null`.
- **`Environment.getSecure(key)`** reads **secrets** — sensitive values (a
  third-party API key). Returns the string, or `null`.

The buckets are **disjoint**: a secret is **never** returned by `get()`, and a
plain var is never returned by `getSecure()`. That keeps a secret from leaking
through a code path that logs the result of a `get()`. Keys are case-sensitive,
exact-match.

> Secrets you read with `getSecure` are plaintext in your module at runtime
> (that's the point — you need them to call out). Don't log them, don't put them
> in a response, and don't copy them into a client bundle.

## What is NOT here

Framework-reserved namespaces (today: **email** provider config) are **host-only**
— resolved and used in Rust where the framework needs them, and **never exposed to
the `.wasm`**. There is no `Environment.email`; you configure email in the
`[email]` block of the same env file and the platform uses it for you (see
[Email](./email.md)). The env imports only ever see your own `vars` / `secrets`.

## Where values live

Vars and secrets live in **two separate dotenv (`.env`) files**, so the disjoint
split is structural and the secrets file can be locked down on its own. On the
edge they are per host, **out of `hosts/`** (so the config watcher never sees a
credential) — the dashboard / edge database replaces them later:

```bash
# $TOIL_ENV_DIR/<host>.env          (default dir /run/toil/env)
PUBLIC_API_BASE=https://api.example.com   # -> Environment.get("PUBLIC_API_BASE")
REGION=eu

# $TOIL_ENV_DIR/<host>.env.secrets  (mode 0600)
STRIPE_KEY=sk_live_xxx                     # -> Environment.getSecure("STRIPE_KEY")

# host-only email config — reserved TOIL_EMAIL_* keys, NEVER exposed to the .wasm
TOIL_EMAIL_ENABLED=true
TOIL_EMAIL_PROVIDER=resend
TOIL_EMAIL_FROM=noreply@example.com
TOIL_EMAIL_API_KEY=re_xxx
```

Each file is plain dotenv: `KEY=value` per line, `#` comments, optional `export`,
optional quotes. Keys with the reserved **`TOIL_`** prefix are framework/host-only
and are stripped from BOTH guest buckets — a tenant can never read them via
`get`/`getSecure` (see [Email](./email.md) for `TOIL_EMAIL_*`).

On the edge, env is loaded **lazily** (the first time your code reads it) into a
**bounded, shared, read-only cache** with idle eviction: the data lives in one
place and is never copied per request, a host that never reads env costs nothing,
secrets are wiped when a host goes cold, and a flood of requests to many distinct
hosts can never grow memory without bound.

## In dev

`toiljs dev` reads `.env` (vars) and `.env.secrets` (secrets) at your project
root, and overlays `process.env` as plain vars for convenience. Both are
gitignored by the scaffold. The ABI is identical to the edge, so code that runs
in dev runs on the edge.

```bash
# .env  (vars)
PUBLIC_API_BASE=http://localhost:4000

# .env.secrets  (secrets; 0600; gitignored)
STRIPE_KEY=sk_test_xxx
```
