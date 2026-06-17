# Auth, sessions, and `@user`

toiljs ships **Toil PQ-Auth**: a post-quantum password login where the password
never leaves the browser and the server stores only public verifier material.
On top of it sit HMAC-signed session cookies, a `@auth` route guard, and a
`@user` type that makes the signed-in user available — fully typed, no type
argument — on both the server (`AuthService.getUser()`) and the generated client
(`getUser()`).

> **Status.** PQ-Auth is a hybrid construction (see [What it is](#what-it-is)).
> It is opt-in and **not hardened to production yet** — the example storage is a
> dev stand-in, the secrets are dev placeholders, and the composition has not had
> an external cryptographic review. See [`docs/auth-todo.md`](./auth-todo.md) for
> the remaining work before it backs real credentials.

`AuthService` is an ambient global (no import). The pieces:

- **`@user`** — declares the authenticated user's shape and registers it as *the* user type.
- **`@auth`** — guards a route (or a whole `@rest` class): a valid session is required or `401`.
- **`AuthService`** — the server runtime: the PQ-Auth crypto, plus mint/read/clear a session and `getUser()`.
- **client `Auth` + generated `getUser()`** — run the login from the browser and read the user for display.

---

## What it is

A password is a weak, low-entropy secret. PQ-Auth turns it into a strong,
**post-quantum** credential and proves possession to the server without the
server (or anyone on the wire, or a future quantum adversary) ever seeing
anything they can replay. It is built from three independent ideas, each
defending a specific attack:

| Layer | Primitive | Defends against |
| --- | --- | --- |
| **Keyed salt** | OPRF (RFC 9497, ristretto255-SHA512) | A breached server (or a passive observer) **precomputing** a password dictionary. |
| **Credential** | Argon2id → ML-DSA-44 (FIPS 204) keypair | The password ever crossing the wire; a stolen verifier being usable without an expensive per-guess attack. |
| **Mutual auth + key** | ML-KEM-768 (FIPS 203) | A phishing/MITM server impersonating the real one; a session with no key to bind to. |

The password is stretched into a signing keypair entirely client-side; only the
**public** key is registered. Login is a challenge-response signature *plus* a
key encapsulation, so both parties authenticate each other. Authentication
(ML-DSA) and key agreement (ML-KEM) are post-quantum; the keyed-salt OPRF is
classical ristretto255 (the one non-PQ layer — a quantum break of it degrades to
a post-breach offline attack, no worse than a plain salt, while defeating
precomputation for everyone else).

### Why a keyed salt (the OPRF)

A normal salted hash (`Argon2id(password, salt)`) lets anyone who learns the
salt — including a future attacker who simply asks the login endpoint for it —
**precompute** a dictionary offline and crack the stored verifier the instant
they breach it. PQ-Auth replaces the salt with the output of a **server-keyed**
OPRF:

```
oprfOutput = OPRF_finalize(password, OPRF_evaluate(k_user, blind(password)))
seed       = Argon2id(oprfOutput, salt)
```

The client **blinds** the password (so the server learns nothing about it),
the server **evaluates** the blinded element under a per-user key `k_user`
derived from a server-secret master seed, and the client **unblinds** to recover
a deterministic, high-entropy `oprfOutput`. Because `k_user` is a server secret,
**no offline work is possible until that secret leaks** — precomputation is
impossible, and even a passive observer who captures a login learns nothing.
The per-user key (`k_user = DeriveKeyPair(masterSeed, username)`) means two
accounts with the same password get different outputs — no cross-account
password-equality leak.

### Why a password-derived signing key

`seed = Argon2id(oprfOutput, salt)` deterministically expands into an
**ML-DSA-44 keypair**. The client registers only the 1312-byte **public** key;
the secret key and seed are zeroized the instant signing is done. The server
stores the public key as a verifier and can only ever *verify* — it never holds
a secret (`crypto.mldsa_verify` is verify-only on the edge). A full server breach
yields public keys, not passwords; recovering a password still requires an
offline Argon2id dictionary attack **and** the leaked OPRF master seed.

### Why ML-KEM (mutual auth + session key)

A signature proves the *client* to the server, but nothing proves the *server*
to the client. PQ-Auth pins the server's static **ML-KEM-768 public key** in the
client. At login the client **encapsulates** a shared secret to that key; only
the genuine server (holding the matching secret key) can **decapsulate** it. Both
sides derive the same session key and the server returns a confirmation tag the
client checks — so a phishing/MITM server that lacks the secret key cannot
complete the handshake.

---

## Flow at a glance

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as Browser<br/>toiljs/client Auth
    participant S as Edge wasm<br/>AuthService
    participant DB as Your store<br/>accounts + challenges

    rect rgb(14, 21, 32)
    Note over U,DB: Register — password never leaves the browser
    U->>C: Auth.register(username, password)
    C->>S: POST /auth/register/start { username, blinded }
    S->>S: OPRF-evaluate(k_user, blinded); issue salt + KDF params
    S-->>C: { salt, params, evaluated }
    C->>C: oprfOutput = finalize(...); seed = Argon2id(oprfOutput, salt)<br/>ML-DSA-44 keypair; sign PoP over (username, publicKey)
    C->>S: POST /auth/register/finish { username, publicKey, regProof }
    S->>S: verifyRegister(publicKey, PoP)
    S->>DB: store Account { username, salt, params, publicKey }
    S-->>C: ok
    end

    rect rgb(22, 15, 31)
    Note over U,DB: Login — mutual authentication
    U->>C: Auth.login(username, password)
    C->>S: POST /auth/login/start { username, blinded }
    S->>DB: store challenge (cid, nonce, iat, exp)
    S-->>C: { cid, aud, salt, params, nonce, iat, exp, evaluated }
    C->>C: oprfOutput = finalize(...); seed; ML-DSA keypair<br/>{ct, ss} = ML-KEM.encapsulate(pinned server key)<br/>M = buildLoginMessage(... ct, params, keyId); sign(M)
    C->>S: POST /auth/login/finish { cid, ct, signature }
    S->>DB: atomic consume challenge(cid)
    S->>S: rebuild M from stored values + ct; verifyLogin<br/>ss = ML-KEM.decapsulate(ct); K = HMAC(ss, ...)<br/>confirm = HMAC(K, ...)
    alt signature valid
        S-->>C: ok + sessionToken + serverConfirm + Set-Cookie
        C->>C: re-derive K from its own ss; check serverConfirm<br/>(server authenticated)
    else invalid / unknown user
        S-->>C: 401, generic, anti-enumeration
    end
    end

    rect rgb(13, 25, 18)
    Note over U,DB: Guarded request — the @auth guard
    U->>C: open or call an @auth route
    C->>S: request, cookies sent automatically
    S->>S: @auth: verify HMAC + expiry on __Host-toil_sess
    alt valid session
        S->>S: handler runs; AuthService.getUser() returns the @user
        S-->>C: 200
    else missing / invalid
        S-->>C: 401 before the handler and body-decode
    end
    end
```

### The signed transcript

The login message `M` the client signs (and the server rebuilds from its own
stored values) is a single fixed binary layout — no JSON, no version negotiation:

```
u8    tag = 1
str   sub              (username)
str   aud              (service audience; server constant)
bytes cid              (challenge id)
bytes nonce            (32 random bytes, server-issued)
u64   iat, u64 exp     (challenge validity window)
bytes ct               (ML-KEM ciphertext)
u32   memKiB, iterations, parallelism   (Argon2id params)
bytes serverKemKeyId   (SHA-256 of the server KEM public key)
```

Signing over all of this binds the login to: the exact challenge (so it can't be
replayed — and `cid` is consumed atomically), the **ciphertext** (so a MITM can't
swap the key encapsulation), the **KDF params** (so a downgrade can't be slipped
past the signature), and the **server key identity** (so it commits to which
server key was used). The mutual-auth tag is then:

```
K       = HMAC-SHA256(sharedSecret, "toil-session-key-v1"    || SHA-256(M))
confirm = HMAC-SHA256(K,            "toil-server-confirm-v1" || SHA-256(M))
```

`K` is the authenticated session key, derived from the KEM shared secret and
bound to the transcript. Only a server that decapsulated correctly derives the
same `K`, so the client checking `confirm` proves the server's identity. (`K` is
the handle for future channel binding; binding the session *cookie* to the
transport needs the TLS exporter, which the wasm guest can't see — a follow-up.)

### Anti-enumeration

`login/start` returns a fully-formed response for **every** username: it always
OPRF-evaluates (a real `k_user` for known users, a deterministic decoy key for
unknown ones) and returns a **deterministic per-user salt** and constant params.
Known and unknown users are byte-indistinguishable, and the eventual signature
simply fails for a non-account. Failures return one generic `401`.

---

## `@user`

Mark one class per program as the user type. It becomes a `@data` codec (so it
serializes into the session) and the return type of `getUser()` everywhere.

```ts
@user
class Account {
  username: string = '';
  admin: bool = false;
  score: u64 = 0;
}
```

There is exactly one `@user` per program; a second is a compile error.

## `@auth`

Put `@auth` on a route, or on the `@rest` class to guard every route in it. The
generated dispatcher checks for a valid, unexpired session **before** the handler
runs (and before any body-decode or cache write); without one it returns `401`.

```ts
@rest('session')
class Session {
  @auth
  @get('/me')
  public me(): Response {
    const u = AuthService.getUser();        // Account | null, auto-typed
    if (u == null) return Response.text('no session\n', 401);
    return Response.bytes(new DataWriter()
      .writeString(u.username).writeBool(u.admin).writeU64(u.score).toBytes());
  }
}
```

`@auth` on the class form guards all routes in it.

## `AuthService` (server)

A global namespace. Session methods read the ambient request
(`Server.currentRequest`), so `getUser()`/`hasSession()` take no argument and are
only meaningful during a dispatch.

### PQ-Auth crypto

Startup config (call once in `main.ts`; identical on every edge instance; never
in a client bundle):

| Member | Notes |
| --- | --- |
| `setSecret(secret)` | HMAC secret for session cookies. |
| `setOprfSeed(seed)` | 32-byte OPRF master seed; per-user keys derive from this + the username. |
| `setServerKemSecretKey(sk)` | Server static ML-KEM-768 secret key (2400 B) used to decapsulate. |
| `setServerKemPublicKey(pk)` | The matching public key (1184 B) for `serverKemKeyId`; it is embedded in `sk` at bytes `[1152, 2336)`, so you can pass `sk.slice(1152, 2336)`. |

Per-request building blocks:

| Member | Notes |
| --- | --- |
| `oprfEvaluate(username, blinded)` | OPRF server step: blind-evaluate under `k_user` derived from the seed + username. Returns the 32-byte evaluated element. |
| `mlkemDecapsulate(ct)` | Recover the 32-byte shared secret from the client ciphertext with the server secret key. |
| `buildLoginMessage(sub, aud, cid, nonce, iat, exp, ct, memKiB, iterations, parallelism, serverKemKeyId)` | The canonical login message `M`. Call it with the server's **own** stored values, never client-echoed fields. |
| `verifyLogin(publicKey, message, signature)` | Verify the ML-DSA login signature under `LOGIN_CONTEXT`. |
| `serverKemKeyId()` | `SHA-256(serverKemPublicKey)` — the key id bound into `M`. |
| `sha256(data)` | SHA-256, for the transcript hash. |
| `deriveSessionKey(sharedSecret, transcriptHash)` | `K = HMAC(sharedSecret, SESSION_KEY_LABEL ‖ transcriptHash)`. |
| `serverConfirmTag(sessionKey, transcriptHash)` | The mutual-auth tag `HMAC(K, SERVER_CONFIRM_LABEL ‖ transcriptHash)`. |
| `buildRegisterMessage(username, publicKey)` / `verifyRegister(...)` | Registration proof-of-possession (under `REGISTER_CONTEXT`). |
| `LOGIN_CONTEXT` / `REGISTER_CONTEXT` | `qauth:login:v1` / `qauth:register:v1` — FIPS 204 signing contexts. |
| `PUBLIC_KEY_LEN` `SIGNATURE_LEN` `KEM_*` `SHARED_SECRET_LEN` `OPRF_*` | Fixed sizes. |

The full register/login orchestration (the four binary endpoints, the
anti-enumeration decoy, the atomic challenge-consume) is in
`examples/basic/server/routes/Auth.ts`. **Storage is the app's** — a tenant's
wasm memory is wiped per request, so accounts and challenges live in an external
store, and challenge-consume **must** be an atomic fetch-and-delete (a
read-then-delete race makes a captured login replayable). The example uses a
**dev-only** KV for this; production wires toildb (see `docs/auth-todo.md`).

### Sessions

| Member | Signature | Notes |
| --- | --- | --- |
| `getUser()` | `(): AuthUser \| null` | The signed-in user, decoded from the verified session, auto-typed to your `@user`. |
| `hasSession()` | `(): bool` | Whether the request carries a valid, unexpired session. What `@auth` calls. |
| `mintSession(userData, ttlSecs?)` | `(Uint8Array, u64=86400): Cookie` | Signed `__Host-toil_sess` cookie carrying `user.encode()`. HttpOnly, Secure, SameSite=Lax. |
| `clearSession()` / `userCookie(...)` / `clearUserCookie()` | | Logout; the readable `__Secure-toil_user` companion (display-only); clear it. |

The session payload is `u8 version ‖ u64 iat ‖ u64 exp ‖ bytes userData`, sealed
with HMAC-SHA256. The HttpOnly `__Host-toil_sess` is the **only** cookie the
server trusts; the readable `__Secure-toil_user` exists solely so the client
`getUser()` can show a name without a round-trip and must never gate anything.

## The client half

```ts
import { Auth } from 'toiljs/client';

await Auth.register(username, password); // OPRF + Argon2id + ML-DSA keypair, send only the public key + PoP
await Auth.login(username, password);    // + ML-KEM encapsulate; resolves only if the server's confirm tag verifies
```

`login` resolves **only after** the client verifies the server's confirmation tag
— so a resolved `login` means mutual authentication succeeded. The secret key,
seed, and shared secret are zeroized as soon as they are used. There is no
recovery: the password *is* the key (see `docs/auth-todo.md` for the recovery
work).

The generated `shared/server.ts` also exports a typed, no-argument client
`getUser()` that reads the readable companion cookie. It is **display-only and
untrusted** — a client can forge it, fooling only its own UI. The server
re-verifies the signed session on every `@auth` request, so authorization never
depends on the readable cookie.

## Security checklist

- Set real secrets in `main.ts`: `setSecret`, `setOprfSeed`, and the server KEM
  keypair — per-deployment, identical on every instance, never in a client
  bundle. The defaults are insecure DEV placeholders.
- Pin **your** server KEM public key in the client and rotate it; the example
  ships a throwaway dev keypair.
- Use a production Argon2id cost (≥ 256 MiB, ≥ 3 iterations); the demo is tuned
  for browser responsiveness.
- Back accounts/challenges with a shared store and make challenge-consume atomic.
- Rate-limit `register` and `login` (online guessing is not stopped by the
  offline-attack resistance).
- Always verify server-side. The server `getUser()` decodes a verified,
  expiry-checked session; the client `getUser()` does not and must not gate
  anything.
- This is an unreviewed hybrid composition — get a cryptographic review before it
  backs real credentials. Tracked in [`docs/auth-todo.md`](./auth-todo.md).
