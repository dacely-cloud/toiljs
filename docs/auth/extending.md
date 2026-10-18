# Extending & integrating auth

Built-in auth is deliberately opinionated so the common case is one line. This page covers the identity
you build ON, `ToilUserId`, and how to go beyond the defaults: keying your own data on a user, a custom
user shape, and hand-writing auth from the same primitives.

## `ToilUserId`

The stable, tenant-scoped user identity is a 256-bit SHA-256 hash of four
length-prefixed fields: the `toil.userid.v1` label, ML-DSA public key, identifier
(the built-in account username), and tenant domain. See the
[exact derivation](./how-it-works.md#the-stable-user-identity-toiluserid).
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
a == b;   // true, same inputs, same id
a != c;   // true, different user
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

## Extending the user: add your own fields

Built-in auth reserves exactly two fields on the authenticated user: `toilUserId` and `username`. To carry
more (a role, a display name, a tenant), just declare your OWN `@user` in your server code while
`server.auth` is on. The build detects it and **extends** it: it injects the reserved `toilUserId` +
`username` as the first two fields and mints sessions for your shape automatically. You do not opt out of
anything, and there is still exactly one `@user` per program.

```ts
@user
class Account {
    admin: bool = false;
    displayName: string = '';
    tenant: string = '';
    // toilUserId + username are INJECTED by the build; do not declare them here.
}
```

Rules:

- Do **not** declare `toilUserId` or `username` yourself. They are reserved and injected; declaring either is
  a compile error (`'username' is reserved by built-in auth`).
- Your `@user` must be default-constructible (give every field an initializer), like any `@data` class.

`AuthService.getUser()` is now typed to YOUR shape:

```ts
const user = AuthService.getUser();   // { toilUserId, username, admin, displayName, tenant } | null
```

**Populating your fields.** Login fills `toilUserId` + `username`; your extra fields start at their declared
defaults (`admin = false`, and so on). The built-in controller cannot know your business fields, so you set
them yourself on one of your own `@auth` routes by reading the user, updating it, and re-minting the session:

```ts
@rest('account')
class AccountApi {
    @auth @post('/promote')
    public promote(): Response {
        const user = AuthService.getUser()!;
        user.admin = true;
        const resp = Response.text('promoted\n');
        resp.setCookie(AuthService.mintSession(user.encode()));   // re-sign the session with the new fields
        resp.setCookie(AuthService.userCookie(user.encode()));    // update the readable companion cookie
        return resp;
    }
}
```

If you would rather hand-write the whole controller instead, you still can: do **not** enable `server.auth`,
and build your own `@user` + routes from the [AuthService primitives](#the-authservice-primitive-reference)
below. But for most apps, extending is all you need.

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
- `mlkemDecapsulate(ct): Uint8Array`, `serverKemKeyId(): Uint8Array`.
- `deriveSessionKey(sharedSecret, transcriptHash)`, `serverConfirmTag(sessionKey, transcriptHash)`: the
  mutual-auth confirmation.
- `sha256(data): Uint8Array`.
- `setOprfSeed(seed)`, `setServerKemSecretKey(sk)`, `setServerKemPublicKey(pk)`: override the seeds/keys.
- Sizes: `PUBLIC_KEY_LEN`, `SIGNATURE_LEN`, `OPRF_ELEMENT_LEN`, `KEM_CIPHERTEXT_LEN`, `SHARED_SECRET_LEN`, …

**Related globals**, `TwoFactor` (email codes; see [email](../services/email.md)), `RateLimitService` (used by
`@ratelimit`), `Environment` (the secret store).

## Two ways in, one behavior

The config flag and the import are identical at build time, both make the build append the shipped
`@user` + `@rest('auth')` controller to the toilscript **entry** set, where their decorators weave and the
`@rest` class self-mounts. (A framework decorator source only weaves as an entry; that's why a plain
`import` of the controller isn't enough on its own, the marker import is detected by the build, which does
the entry injection.) This is why built-in auth needs no runtime registration call.


## Static server typings

Server editor declarations ship with the package; they do not require an app
build. Importing `toiljs/server/runtime` loads them. A project with no runtime
import can add `/// <reference types="toiljs/server/globals" />` to a declaration
file, or include `"toiljs/server/globals"` in its tsconfig `types` alongside
`"assembly"`. The generated `toil-server-env.d.ts` is only a reference shim;
create, build and doctor share the same declaration source.

A plain ToilScript compile needs the framework globals in `--lib`. Without a
custom `@user` entry, `AuthService.getUser()` exposes the standard signed
identity prefix (`toilUserId: Uint8Array` and `username: string`) without a
generated application declaration. Its decoder validates the 32-byte identity.
An explicit `@user` source entry preserves the application's full typed codec,
including additional fields. The framework auth build still appends the built-in
user codec when auth is enabled and no custom user exists. That codec also
supplies the account controller's session encoder.

## Initializing application records during registration

Install `AuthService.onRegistered((id, username, email) => { ... })` from your
server entry point. The callback receives the reserved stable `ToilUserId` and
validated account fields. It runs before the account becomes active and uses the
same Action budget as registration. Use conditional create/upsert logic suitable
for retries: the callback may run more than once.

If it traps, registration remains pending and cannot sign in. A new registration
attempt with the same credentials and proof resumes it and reruns the initializer.
Earlier successful database calls remain committed, so callbacks must be
idempotent. This is appropriate for creating an initial profile or pending
eligibility record; it does not supply extra age/profile answers absent from the
registration protocol.
