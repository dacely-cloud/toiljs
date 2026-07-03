# Using auth

## 1. Enable it

Either the config flag (canonical) or a one-line import, both do the same thing (the build appends the
framework's auth controller + user shape to your server as compiled entries, so `/auth/*` self-mounts):

```ts
// toil.config.ts, canonical
export default defineConfig({ server: { auth: true } });
```

```ts
// server/main.ts, escape hatch (equivalent)
import 'toiljs/server/auth';
```

There is also an `AuthService.enable()` no-op you can call for discoverability, but enabling is done by the
flag/import above (it happens at build time). Turn it off by removing the flag/import, with neither, no
`/auth` routes and no accounts collection are generated. It is strictly opt-in.

## 2. The client

`toiljs/client` ships the browser half, it runs the OPRF blinding, Argon2id, ML-DSA keygen, and ML-KEM
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
    serverKemPublicKey: MY_KEM_PUB,   // REQUIRED in production, pin your deployment's KEM key
});
```

> **Production:** the client ships with the DEV KEM public key pinned. A real deployment MUST pass its own
> `serverKemPublicKey` (derived from `AUTH_KEM_SK`). See [Configuration](./configuration.md).

## 2b. Client-side: who's logged in, and protecting pages

`register`/`login` set the session cookies; to *render* login state on the client, use the generated
`getUser()` (emitted from the built-in `@user`). It reads the **readable** `__Secure-toil_user` companion
cookie and returns the typed user or `null`, instant, no network call. It is **display-only**; the server
still enforces access via `@auth`, so never trust it for authorization.

```tsx
import { getUser } from 'shared/server';   // generated; typed to the built-in @user

function Nav() {
    const user = getUser();                // { toilUserId, username } | null
    return user
        ? <span>Hi {user.username} <button onClick={logout}>Log out</button></span>
        : <a href="/login">Log in</a>;
}

async function logout() {
    await fetch('/auth/logout', { method: 'POST' });
    location.href = '/login';              // cookies are cleared; bounce to login
}
```

Gate a whole client route by redirecting when there's no session:

```tsx
export default function Dashboard() {
    const user = getUser();
    if (user == null) { location.href = '/login'; return null; }   // not logged in -> to /login
    return <main>Welcome, {user.username}</main>;
}
```

The authoritative check is still the server: any data this page fetches should come from an `@auth` route,
so a user who forged/deleted the readable cookie sees the redirect OR a `401`, never real data.

## 2c. Handling errors

`Auth.register` / `Auth.login` reject with a message you can show. The important distinguishable cases:

```ts
try {
    await Auth.register(username, password);
} catch (e) {
    const m = String(e);
    if (m.includes('already registered')) setError('That username is taken, log in instead.');
    else setError('Could not register, try again.');
}

try {
    await Auth.login(username, password);
} catch {
    // Wrong password OR unknown user both fail generically (anti-enumeration), one message.
    setError('Incorrect username or password.');
}
```

- **Username taken** → `register` throws `auth: username already registered (log in instead)` (a
  distinguishable case so you can guide the user).
- **Wrong password / unknown user** → `login` throws generically (`auth: request failed`): by design,
  the two are indistinguishable, so use ONE "incorrect username or password" message.
- **Rate limited** → after 5 attempts / 60s a `429` surfaces as the same generic throw; back off and tell
  the user to wait.

## 3. Guard your routes: `@auth`

Put `@auth` on a route method or a whole `@rest` class. The generated dispatcher checks for a valid signed
session **before** your handler runs and returns `401` otherwise. `@auth` is unchanged by built-in auth,
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
    user.toilUserId;  // Uint8Array(32), the stable id bytes
}

// The stable identity as a ToilUserId (gate on hasSession() first, see note).
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
| `POST /auth/register/finish` | `str(username) bytes(pubkey) bytes(proof)` | `u8(status)`, `0` ok, `1` username taken |
| `POST /auth/login/start` | `str(username) bytes(blinded)` | `bytes(cid) str(aud) u32(mem) u32(iters) u32(par) bytes(salt) bytes(nonce) u64(iat) u64(exp) bytes(evaluated)` |
| `POST /auth/login/finish` | `bytes(cid) bytes(ct) bytes(sig)` | `u8(0) bytes(sessionToken) bytes(serverConfirm)` + `Set-Cookie`, or `u8(≠0)` on failure |
| `GET /auth/me` *(`@auth`)* | (none) | `bytes(toilUserId) str(username)` |
| `POST /auth/logout` *(`@auth`)* | (none) | `200` + cookie-clearing `Set-Cookie` |

Rate limiting: every register/login POST carries `@ratelimit(SlidingWindow, 5, 60)` (5 requests / 60s per
client) out of the box, so brute-force is throttled before it reaches the crypto.

## 6. Under `toiljs dev`

Everything runs locally with **zero setup**: the dev server emulates the ToilDB account/challenge storage
and the ML-DSA/ML-KEM/OPRF host functions in process, and the auth secrets fall back to insecure DEV
values. Register and login span requests (the accounts persist for the dev session). You'll see a warning
that `AUTH_SESSION_SECRET` is unset, that's expected in dev; set it before you deploy (see
[Configuration](./configuration.md)).

## 7. `Server.REST.auth.*`

Because the controller is a normal `@rest('auth')` class, a typed `Server.REST.auth.*` fetch client is
generated for free (`me`, `logout`, and the register/login methods). Use it for `/me` and `/logout`; but
**drive register/login through `toiljs/client` `Auth`**, not the generated client, only the `Auth` helper
runs the required browser-side OPRF/Argon2id/ML-DSA/ML-KEM crypto.
