# How Toil auth works

Toil auth is a **post-quantum, password-based, mutually-authenticated** login. The design goal: the user
types a password, but the server never sees it, never stores it, and can't be phished into leaking a
verifier, and every primitive is quantum-resistant.

This page explains the protocol. You do not need to understand it to use auth (see [Usage](./usage.md)),
but you should understand the guarantees before you ship.

## The building blocks

| Primitive | Role |
| --- | --- |
| **OPRF** (RFC 9497, ristretto255-SHA512) | A *server-keyed* salt. The client blinds its password, the server evaluates it under a per-user key, the client unblinds. The result can't be computed without the server, so a stolen database can't be brute-forced offline. |
| **Argon2id** | Stretches the OPRF output into key material (memory-hard, GPU/ASIC-resistant). Runs in the browser. |
| **ML-DSA-44** (FIPS 204) | The user's identity key pair is *derived* from the Argon2id output. The server stores only the **public** key. Login is proved by an ML-DSA signature. |
| **ML-KEM-768** (FIPS 203) | Key encapsulation on login: the server proves it holds its KEM secret by returning a confirmation tag only derivable from the decapsulated shared secret → **mutual** auth (anti-phishing). |
| **HMAC-SHA256** | Signs the session cookie (`AUTH_SESSION_SECRET`). |

> The whole thing is sometimes called an *aPAKE* (asymmetric password-authenticated key exchange). Do not
> call it OPAQUE, this is Toil's own OPRF + KEM + signature construction.

## What the server stores

Per account, in ToilDB (`@database AuthDb`):

- `username`, a deterministic `salt`, the **ML-DSA public key**, and the Argon2id params.

That's it. **No password, no password hash, no verifier that can be brute-forced without the OPRF key.**
Login challenges are a second collection, consumed exactly once (atomic `getDelete`).

## Registration

```
 Browser (client)                                   Toil edge (server)
 ─────────────────                                  ──────────────────
 blind(password)                                    OPRF key = f(seed, username)
        │  username, blinded                                │
        │ ───────── POST /auth/register/start ───────────► │
        │                                                   │  evaluated = OPRF(blinded)
        │  ◄──── {mem,iters,par, salt, evaluated} ───────── │  (salt is deterministic per user)
        │                                                   │
 unblind → oprfOut                                          │
 seed  = Argon2id(oprfOut, salt, params)                    │
 (pk, sk) = ML-DSA-44.keygen(seed)                          │
 proof = ML-DSA.sign(sk, "register|username|pk")            │
        │  username, pk, proof                              │
        │ ───────── POST /auth/register/finish ──────────► │
        │                                                   │  verifyRegister(pk, msg, proof)  ✓ proof-of-possession
        │  ◄──────────── {status: 0 ok | 1 taken} ──────── │  store AuthAccount{username, salt, pk, params}
```

The server never learns the password or the secret key `sk`, only the public key `pk` and a proof the
client holds the matching `sk`. A duplicate username returns a **distinguishable** `status = 1` (so the UI
can say "taken, log in instead"); everything else fails generically.

## Login (with mutual auth)

```
 Browser (client)                                   Toil edge (server)
 ─────────────────                                  ──────────────────
 blind(password)                                            │
        │  username, blinded                                │
        │ ───────── POST /auth/login/start ──────────────► │  evaluated = OPRF(blinded)   (ALWAYS, even unknown user)
        │                                                   │  if known: store Challenge{cid, nonce, iat, exp}
        │  ◄─ {cid, aud, params, salt, nonce, iat, exp, ── │  (identical response whether the user exists or not)
        │       evaluated}                                  │
 unblind → Argon2id → (pk, sk) = ML-DSA.keygen              │
 (ct, ssС) = ML-KEM-768.encapsulate(serverKemPublicKey)     │
 msg = "login|username|aud|cid|nonce|iat|exp|ct|params|kid" │
 sig = ML-DSA.sign(sk, msg)                                 │
        │  cid, ct, sig                                     │
        │ ───────── POST /auth/login/finish ─────────────► │  ch = challenges.getDelete(cid)   (consume once; check exp)
        │                                                   │  rebuild msg from OUR stored values + ct
        │                                                   │  verifyLogin(acct.pk, msg, sig)   ✓ it's really this user
        │                                                   │  ssS = ML-KEM.decapsulate(ct)     ✓ we hold the KEM key
        │                                                   │  K = deriveSessionKey(ssS, H(msg))
        │  ◄──── {0, sessionToken, serverConfirm} ──────── │  serverConfirm = tag(K, H(msg))
        │      + Set-Cookie: __Host-toil_sess=…             │  mint session cookie
 verify serverConfirm using ssC   ✓ the server is genuine   │
```

Two verifications, both required:
1. **The server verifies the client**: the ML-DSA signature over a message bound to the challenge, the
   Argon2id params, and the server's KEM key id. Replays fail (the challenge is consumed).
2. **The client verifies the server**: the `serverConfirm` tag is derivable only from the ML-KEM shared
   secret, which only the holder of the KEM secret key can decapsulate. A phishing site can't forge it.

## Anti-enumeration

`/login/start` behaves identically for a known and an unknown user: it always runs the OPRF (a decoy key
for unknown users), returns a **deterministic** per-user salt and constant params, and a fresh challenge.
The challenge is persisted only for a real account, and `/login/finish` fails generically at consume for an
unknown user. So an attacker can't probe which usernames exist. Every failure path returns the same
`401 auth: request failed`.

## Sessions & cookies

On successful login the server mints **two** cookies:

- **`__Host-toil_sess`**: the authoritative session. HMAC-SHA256 signed with `AUTH_SESSION_SECRET`,
  `HttpOnly`, `Secure`, `SameSite=Lax`. It carries the `@user` codec payload. `@auth` and
  `AuthService.getUser()` open + verify this cookie server-side; a forged or tampered cookie fails.
- **`__Secure-toil_user`**: a **readable** companion carrying the same payload, so the browser can show
  "logged in as …" via the client's `getUser()`. The server **never trusts it**, it is display-only.

Each request runs in a fresh wasm instance, but the signed cookie is self-contained, so no server-side
session store is needed. `AUTH_SESSION_SECRET` must be identical across every edge instance (it is, via the
env store) so a cookie minted anywhere verifies everywhere.

## The stable user identity: `ToilUserId`

At login the server derives a stable, tenant-scoped id and stores it in the session (the first field of the
built-in `@user`):

```
toilUserId = SHA-256( mldsaPublicKey ‖ username ‖ domain )      // 256 bits
```

- **Stable:** same login key + username on the same tenant `domain` → same id, forever, across sessions
  and devices. Key your own data on it.
- **Opaque + one-way:** it's a hash: safe to store, log, or expose without leaking the key or the address.
- Read it anywhere with `AuthService.userId()`. See [Extending](./extending.md#toiluserid) for the
  `ToilUserId` API (O(1) `==` / `!=`, `toHex()`, …).

## Threat-model summary

- **Server database stolen** → attacker gets public keys + salts, not passwords. Brute-forcing needs the
  OPRF key (server-side) *and* Argon2id work per guess.
- **Server compromised / malicious** → still can't recover passwords (only public keys) and can't forge a
  past session without `AUTH_SESSION_SECRET`.
- **Phishing site** → can't produce the `serverConfirm` tag (no KEM secret), so a correct client aborts.
- **Quantum adversary** → ML-DSA + ML-KEM are post-quantum; the OPRF/Argon2id/HMAC pieces are classical but
  not the long-term identity or key-exchange.
- **Replay** → challenges are single-use (`getDelete`) with a short TTL.

Residual responsibilities are yours: set the [secrets](./configuration.md), pin your deployment's KEM
public key in the client, and raise the Argon2id params for production.
