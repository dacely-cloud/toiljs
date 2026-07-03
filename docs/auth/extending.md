# Extending & integrating auth

Built-in auth is deliberately opinionated so the common case is one line. This page covers the identity
you build ON, `ToilUserId`, and how to go beyond the defaults: keying your own data on a user, a custom
user shape, and hand-writing auth from the same primitives.

## `ToilUserId`

The stable, tenant-scoped user identity: `sha256(mldsaPublicKey ‖ identifier ‖ domain)`, a 256-bit value.
It's a **global** (no import), like `crypto`.

```ts
// Read the current user's id in any handler (gate on hasSession(), see the null note below).
const id: ToilUserId = AuthService.userId()!;

// Or derive one yourself.
const id2 = ToilUserId.derive(mldsaPublicKey, 'alice@example.com', 'acme.dacely.com');
```

| Member | Description |
| --- | --- |
| `ToilUserId.derive(pk, identifier, domain)` | Derive from an ML-DSA public key + email/username + tenant domain. Deterministic. |
| `ToilUserId.fromBytes(b)` | Rebuild from a 32-byte digest (from `toBytes()` or storage). |
| `toBytes(): Uint8Array` | The 32 identity bytes. |
| `toHex(): string` | Lowercase 64-char hex, a convenient string key. |
| `isZero(): bool` | True for the unset / anonymous id. |
| `equals(other): bool` | Value equality. |
| `a == b` / `a != b` | Overloaded value comparison, **O(1)** (four `u64` word compares, no byte loop, no allocation). |

```ts
const a = ToilUserId.derive(pk, 'alice', 'acme.com');
const b = ToilUserId.derive(pk, 'alice', 'acme.com');
const c = ToilUserId.derive(pk, 'bob',   'acme.com');
a == b;   // true , same inputs, same id
a != c;   // true , different user
```

> **Null-check gotcha:** because `ToilUserId` overloads `==`, `AuthService.userId() == null` does NOT
> type-check (`==` expects a `ToilUserId`). Gate with `AuthService.hasSession()` and then `userId()!`, or
> compare with `getUser()` (a plain nullable). `===` is reference identity in AssemblyScript and is not
> overloadable, use `==` for value equality.

## Keying your own data on the user

`toilUserId` is the right key for per-user data, it's stable across sessions/devices and opaque. Use the
hex as a string key, or the bytes in a `@data` key class:

```ts
@data
class UserKey {
    id: Uint8Array = new Uint8Array(0);      // toilUserId bytes
    constructor(id: Uint8Array = new Uint8Array(0)) { this.id = id; }
}

@data class Profile { displayName: string = ''; bio: string = ''; }

@database
class AppDb {
    @collection static profiles: Documents<UserKey, Profile>;
}

@rest('profile')
class ProfileApi {
    @auth
    @post('/')
    public save(ctx: RouteContext): Response {
        const key = new UserKey(AuthService.userId()!.toBytes());
        const p = Profile.decode(ctx.request.body);
        // Save this user's profile. create is insert-only, so the first save creates
        // the record and later saves overwrite the existing one with enqueue.
        if (!AppDb.profiles.create(key, p)) {
            AppDb.profiles.enqueue(key, p);
        }
        return Response.text('saved\n');
    }
}
```

## A custom user shape: opt out and hand-write

Built-in auth ships the single `@user` (`{ toilUserId, username }`), and there is exactly **one `@user` per
program**. If you need a richer authenticated user (roles, a display name, a tenant), do **not** enable
`server.auth`; hand-write a controller and your own `@user` using the same primitives. The
`examples/basic` app does exactly this, copy `server/routes/Auth.ts` + `server/routes/Session.ts` as your
starting point. The shape:

```ts
@user
class Account {
    username: string = '';
    admin: bool = false;
    score: u64 = 0;
}

// After verifyLogin succeeds, mint your own session payload:
resp.setCookie(AuthService.mintSession(account.encode(), 3600));
resp.setCookie(AuthService.userCookie(account.encode(), 3600));
```

You still get `@auth`, `AuthService.getUser()` (typed to YOUR `@user`), and every crypto primitive, you're
just choosing your own routes and user fields. You can still derive a `ToilUserId` yourself and put it in
your `@user` if you want the stable id.

## Adding email verification / 2FA

Layer a second factor on top of the session with `TwoFactor` (stateless email codes, no DB; see
[email](../services/email.md)). Typical flow: after login, require a verified email before granting access to
sensitive routes.

```ts
@rest('2fa')
class TwoFactorApi {
    // Step 1: email a code to the logged-in user, hand back the signed token.
    @auth @post('/send')
    public send(): Response {
        const email = /* the user's email, e.g. their username, or a stored profile field */;
        const ch = TwoFactor.send(email, 'login');    // emails the code, returns { token, status }
        return Response.bytes(new DataWriter().writeString(ch.token).toBytes());
    }

    // Step 2: verify the code the user typed against the token.
    @auth @post('/verify')
    public verify(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const token = r.readString(); const email = r.readString(); const code = r.readString();
        if (!TwoFactor.verify(token, email, code)) return Response.text('bad code\n', 401);
        // Mark this session 2FA-verified: re-mint the session with a flag in your own @user, or store a
        // per-user "verified" record keyed on AuthService.userId().
        return Response.text('verified\n');
    }
}
```

`TwoFactor` gives integrity + expiry but not single-use (a code re-verifies within its TTL); keep the TTL
short. For a branded email, use `TwoFactor.issue(...)` (returns the code without sending) + your own
`Emails.*` template. Call `TwoFactor.setSecret(...)` once at startup in production.

## The `AuthService` primitive reference

Everything the built-in controller is built from, available for hand-written auth. All are ambient globals
(no import).

**Sessions & cookies**
- `mintSession(userData: Uint8Array, ttlSecs?: u64): Cookie`: the signed `__Host-toil_sess` cookie.
- `userCookie(userData, ttlSecs?): Cookie`: the readable `__Secure-toil_user` companion.
- `clearSession(): Cookie` / `clearUserCookie(): Cookie`.
- `hasSession(): bool`: the `@auth` predicate.
- `getSessionBytes(): Uint8Array | null`: the verified `@user` payload bytes.
- `getUser(): <your @user> | null`: decoded, typed to your `@user`.
- `userId(): ToilUserId | null`: the stable id (built-in `@user` layout).
- `setSecret(secret: Uint8Array)`: override the session HMAC key programmatically.

**Post-quantum login crypto**
- `oprfEvaluate(username, blinded): Uint8Array`: server-keyed OPRF eval.
- `buildRegisterMessage(username, pk)` / `verifyRegister(pk, msg, sig): bool`: proof-of-possession.
- `buildLoginMessage(sub, aud, cid, nonce, iat, exp, ct, memKiB, iterations, parallelism, serverKemKeyId)`
  / `verifyLogin(pk, msg, sig): bool`.
- `mlkemDecapsulate(ct): Uint8Array` · `serverKemKeyId(): Uint8Array`.
- `deriveSessionKey(sharedSecret, transcriptHash)` · `serverConfirmTag(sessionKey, transcriptHash)`: the
  mutual-auth confirmation.
- `sha256(data): Uint8Array`.
- `setOprfSeed(seed)` · `setServerKemSecretKey(sk)` · `setServerKemPublicKey(pk)`: override the seeds/keys.
- Sizes: `PUBLIC_KEY_LEN`, `SIGNATURE_LEN`, `OPRF_ELEMENT_LEN`, `KEM_CIPHERTEXT_LEN`, `SHARED_SECRET_LEN`, …

**Related globals**, `TwoFactor` (email codes; see [email](../services/email.md)), `RateLimitService` (used by
`@ratelimit`), `Environment` (the secret store).

## Two ways in, one behavior

The config flag and the import are identical at build time, both make the build append the shipped
`@user` + `@rest('auth')` controller to the toilscript **entry** set, where their decorators weave and the
`@rest` class self-mounts. (A framework decorator source only weaves as an entry; that's why a plain
`import` of the controller isn't enough on its own, the marker import is detected by the build, which does
the entry injection.) This is why built-in auth needs no runtime registration call.
