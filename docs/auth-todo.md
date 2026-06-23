# Auth: production TODO and toildb migration

Tracking doc for finishing the Toil PQ-Auth system (shipped experimental in
**v0.0.52**). The cryptographic core is in place; what is left is the deployment
substrate, protocol hardening, and account lifecycle.

> This system is a **hybrid, experimental** password-authenticated login and is **NOT a framework
> default until externally reviewed** (see Tier 2.8). It is opt-in: a tenant must wire
> it. The OPRF layer is classical ristretto255 (the one non-PQ piece); auth (ML-DSA-44)
> and key agreement (ML-KEM-768) are post-quantum.

## What ships today (v0.0.52)

- OPRF keyed salt (RFC 9497 ristretto255-SHA512, mode 0x00, per-user key) -> precomputation resistance.
- ML-DSA-44 client auth + registration proof-of-possession.
- ML-KEM-768 mutual auth: client encapsulates to a pinned server key, server returns a confirmation tag.
- Login enumeration fixed (deterministic per-user salt).
- Atomic single-use challenge consume (shape is correct; storage is the dev KV, see below).

Key files: `server/globals/auth.ts` (the `AuthService` global), `src/client/auth.ts`
(browser), `src/devserver/{crypto,kv}.ts` (dev host mocks + dev KV), the Rust edge host
imports in `toil-backend` (`crypto.mlkem_decapsulate`, `crypto.voprf_evaluate`),
`examples/basic/server/routes/Auth.ts` (the flow).

---

## Tier 1, blocks production (cannot run on the edge yet)

### 1.1 Storage on toildb (THE blocker) -- "when building toildb, consider this"
The accounts + login challenges live in the **DEV-ONLY** `kv.*` Map
(`src/devserver/kv.ts`), which is intentionally **not** on the production edge
(`toil-backend` `HOST_IMPORTS`), so a module importing `kv.*` will not instantiate in
prod. When toildb lands:
- **toildb MUST provide an atomic fetch-and-delete** (single-call read+remove). The
  login challenge consume relies on it; a read-then-delete race makes a login replayable.
  It also needs `get` and `put`.
- Migrate **two stores**: `Accounts` (username -> {salt, params, publicKey}) and
  `Challenges` (cid -> {username, nonce, iat, exp}) in `examples/basic/server/routes/Auth.ts`.
- Add the toildb host imports to `toil-backend` `HOST_IMPORTS` + `define_*_imports`.
- Then **delete `src/devserver/kv.ts`**, the `kv.*` entries in `module.ts`
  `PROVIDED_IMPORTS`, and the `buildKvImports` wiring in `host.ts`. Grep `REMOVE KV LATER`.

### 1.2 Real secrets (not dev placeholders)
All three must come from the managed env / `getSecure` store, per-deployment, identical
across edge instances, and rotatable:
- session HMAC secret (still the `...CHANGE-ME` default in `auth.ts`),
- OPRF master seed (currently `sha256Text('toil-demo-oprf-seed-v1')`),
- **server ML-KEM keypair** -- generate a real one per deployment and pin **its** public
  key in the client (today a fixed demo key is pinned in `src/client/auth.ts`, secret in
  the example `Auth.ts`).

### 1.3 Rate limiting on the auth routes
`@ratelimit` exists (`docs/ratelimit.md`) but is not wired onto register/login. Add
per-username + per-IP throttling with backoff/lockout. Offline resistance is good; online
guessing + registration spam are currently open.

### 1.4 Production Argon2id params
Demo uses 32 MiB / 2 iters for tab responsiveness. Raise to >= 256 MiB / >= 3 iters and
enforce a server-side floor.

### 1.5 Gas calibration (edge metering)
`MLKEM768_DECAPSULATE` and `VOPRF_EVALUATE` (`toil-backend src/config.rs`) are
**conservative 12,000,000 placeholders copied from `MLDSA44_VERIFY`, not benchmarked**.
They are charged correctly (before reads) and DoS-bounded by a test, and over-charge
(fail-closed safe), but should be calibrated: measure cyc/op via `crypto::bench`,
multiply by `GAS_PER_CYCLE`, round up ~30%, replace. Same TODO as `MLDSA44_VERIFY` itself.

### 1.6 Real-edge end-to-end
Never run: a full guest-dispatch through the **running** Rust edge exercising the two new
imports (only proven at unit + interop-vector level + structurally identical to the
in-prod `mldsa_verify` import). Do before trusting in prod.

---

## Tier 2, protocol hardening

### 2.6 A properly bound session key, DONE (on main, unreleased)
The session key is now `K = HMAC-SHA256(sharedSecret, SESSION_KEY_LABEL || H(M))` and the
mutual-auth tag is `HMAC-SHA256(K, SERVER_CONFIRM_LABEL || H(M))` (`AuthService.deriveSessionKey`
+ `serverConfirmTag`; client mirrors it with hash-wasm `createHMAC`). REMAINING: binding the
*session cookie* to the transport (so a stolen cookie is useless on another channel) needs
the TLS exporter, which the wasm guest cannot see, an edge/transport follow-up, not doable
purely in the guest.

### 2.7 Bind the KDF params + server key into the transcript, DONE (on main, unreleased)
The single `buildLoginMessage` now binds the ML-KEM ciphertext, the Argon2id params
(mem/iters/par), and `serverKemKeyId = SHA-256(serverKemPublicKey)`. Closes
key-substitution and param-downgrade confusion. (There is ONE login message format, no
versioned variants.)

### 2.8 External cryptographic review (the gate)
Hand-rolled KEM + signature + OPRF composition with no security proof. Transcript binding
especially needs a cryptographer. This is a human task; it cannot be self-served. Make it
tractable: write the wire spec (messages, what each signature/MAC covers, the KDF tree) as
a reviewable artifact.

---

## Tier 3, account lifecycle (missing today)

### 3.1 Password change / key rotation
Re-derive under a fresh salt while authenticated, re-register the new public key. None
exists today.

### 3.2 Recovery
"The password IS the key, no recovery" -> a forgotten password is a permanently dead
account. Needs recovery codes or a second factor (ties to the 2FA crate already on the
backend "left to do" list + the existing email support).

### 3.3 Revocation
No way to kill a compromised credential except deleting the account.

### 3.4 Tighten registration enumeration
`register/finish` still leaks "taken" via the generic fail after the PoP round.

---

## Design decisions (open)

### D1. User id = sha256(public key)? -- CAUTION: breaks under key rotation
Yes, the public key is still the verifier (`AuthService.verifyLogin` checks the ML-DSA
signature against the stored public key). `sha256(publicKey)` is a fine **content-addressed
credential fingerprint** (collision-resistant, re-derivable, good for dedup). BUT:
- It **cannot be the login lookup key**: at `login/start` the client presents an identifier
  to fetch the salt + OPRF evaluation *before* it has derived its keypair (it needs the
  OPRF response to derive the key -> to get the pubkey). So a human-meaningful **handle**
  (username/email) is still required as the OPRF `info` + the `login/start` lookup key.
- It is **not stable across password change**: rotating the password changes the pubkey,
  hence `sha256(pubkey)`. If the user id must survive a password change, it must be a
  separate stable id (random UUID assigned at registration), with `sha256(pubkey)` treated
  as the *current credential* fingerprint, not the permanent identity.
- **Recommendation:** handle (username/email) = login + OPRF info; permanent userId =
  random id at registration; `sha256(pubkey)` = credential fingerprint (verifiable, for
  dedup / "is this the same key"). Revisit only if password rotation is ruled out.

### D2. OPRF mode vs VOPRF/DLEQ
Plain OPRF mode by design (server auth comes from the ML-KEM layer). Add
DLEQ only if the client must verify OPRF-key consistency. Likely unnecessary.

### D3. Multi-device / WebAuthn-style per-device keys
One-key-per-user (deterministic from password) is fine unless hardware-backed or per-device
keys are wanted later; that needs a credential-set model.

---

## Suggested sequence
toildb storage (1.1) -> real secrets + real pinned KEM key (1.2) -> rate limiting (1.3) ->
HKDF session key (2.6) + transcript binding (2.7) -> external review (2.8) -> lifecycle
(3.1-3.3). 1.1-1.3 turn the demo into something deployable; 2.8 makes it trustworthy.
