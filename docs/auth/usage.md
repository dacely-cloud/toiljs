# Using auth

## 1. Enable it

Either the config flag (canonical) or a one-line import — both do the same thing (the build appends the
framework's auth controller + user shape to your server as compiled entries, so `/auth/*` self-mounts):

```ts
// toil.config.ts  — canonical
export default defineConfig({ server: { auth: true } });
```

```ts
// server/main.ts  — escape hatch (equivalent)
import 'toiljs/server/auth';
```

There is also an `AuthService.enable()` no-op you can call for discoverability, but enabling is done by the
flag/import above (it happens at build time). Turn it off by removing the flag/import — with neither, no
`/auth` routes and no accounts collection are generated. It is strictly opt-in.

## 2. The client

`toiljs/client` ships the browser half — it runs the OPRF blinding, Argon2id, ML-DSA keygen, and ML-KEM
encapsulation, and talks to `/auth/*`. You never touch the crypto.

```ts
import { Auth } from 'toiljs/client';

// Create an account. Throws on a taken username or a transport error.
await Auth.register(username, password);

// Log in. On success the browser holds the signed session cookie; subsequent
// requests to @auth routes are authorized automatically.
await Auth.login(username, password);
```

Options (second argument, `AuthOptions`):

```ts
await Auth.login(username, password, {
    baseUrl: '/auth',                 // default; change if you mount elsewhere
    serverKemPublicKey: MY_KEM_PUB,   // REQUIRED in production — pin your deployment's KEM key
});
```

> **Production:** the client ships with the DEV KEM public key pinned. A real deployment MUST pass its own
> `serverKemPublicKey` (derived from `AUTH_KEM_SK`). See [Configuration](./configuration.md).

For logout / "who am I", call the endpoints directly (they're plain `fetch`):

```ts
await fetch('/auth/logout', { method: 'POST' });
const me = await fetch('/auth/me'); // 200 with the user, or 401
```

## 3. Guard your routes — `@auth`

Put `@auth` on a route method or a whole `@rest` class. The generated dispatcher checks for a valid signed
session **before** your handler runs and returns `401` otherwise. `@auth` is unchanged by built-in auth —
it's the same decorator you'd use with hand-written auth.

```ts
@rest('account')
class AccountApi {
    @auth                       // this route needs a session
    @get('/settings')
    public settings(): Response { /* … */ }

    @get('/public')             // this one is open
    public open(): Response { /* … */ }
}

@auth                           // …or guard the ENTIRE class
@rest('admin')
class AdminApi { /* every route requires a session */ }
```

## 4. Read the current user

Inside any handler:

```ts
// The typed logged-in user (the built-in `@user`: toilUserId + username), or null.
const user = AuthService.getUser();
if (user != null) {
    user.username;    // string
    user.toilUserId;  // Uint8Array(32) — the stable id bytes
}

// The stable identity as a ToilUserId (gate on hasSession() first — see note).
if (AuthService.hasSession()) {
    const id = AuthService.userId()!;   // ToilUserId
    // key your own data on id (see Extending)
}
```

> `ToilUserId` overloads `==`, so `AuthService.userId() == null` does not type-check. Gate with
> `AuthService.hasSession()` and then use `userId()!`, or use `getUser()` and null-check that.

## 5. The endpoint wire contract

You normally use the `Auth` client, but the raw endpoints are binary (`DataWriter`/`DataReader`, never
JSON):

| Route | Request body | Response |
| --- | --- | --- |
| `POST /auth/register/start` | `str(username) bytes(blinded)` | `u8(0) u32(mem) u32(iters) u32(par) bytes(salt) bytes(evaluated)` |
| `POST /auth/register/finish` | `str(username) bytes(pubkey) bytes(proof)` | `u8(status)` — `0` ok, `1` username taken |
| `POST /auth/login/start` | `str(username) bytes(blinded)` | `bytes(cid) str(aud) u32(mem) u32(iters) u32(par) bytes(salt) bytes(nonce) u64(iat) u64(exp) bytes(evaluated)` |
| `POST /auth/login/finish` | `bytes(cid) bytes(ct) bytes(sig)` | `u8(0) bytes(sessionToken) bytes(serverConfirm)` + `Set-Cookie`, or `u8(≠0)` on failure |
| `GET /auth/me` *(`@auth`)* | — | `bytes(toilUserId) str(username)` |
| `POST /auth/logout` *(`@auth`)* | — | `200` + cookie-clearing `Set-Cookie` |

Rate limiting: every register/login POST carries `@ratelimit(SlidingWindow, 5, 60)` (5 requests / 60s per
client) out of the box, so brute-force is throttled before it reaches the crypto.

## 6. Under `toiljs dev`

Everything runs locally with **zero setup**: the dev server emulates the ToilDB account/challenge storage
and the ML-DSA/ML-KEM/OPRF host functions in process, and the auth secrets fall back to insecure DEV
values. Register and login span requests (the accounts persist for the dev session). You'll see a warning
that `AUTH_SESSION_SECRET` is unset — that's expected in dev; set it before you deploy (see
[Configuration](./configuration.md)).

## 7. `Server.REST.auth.*`

Because the controller is a normal `@rest('auth')` class, a typed `Server.REST.auth.*` fetch client is
generated for free (`me`, `logout`, and the register/login methods). Use it for `/me` and `/logout`; but
**drive register/login through `toiljs/client` `Auth`**, not the generated client — only the `Auth` helper
runs the required browser-side OPRF/Argon2id/ML-DSA/ML-KEM crypto.
