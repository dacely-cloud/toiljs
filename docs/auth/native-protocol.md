# Native client protocol and vectors

A native client can implement the same protocol as `toiljs/client` without a
WebView. The portable known-answer fixture is [vectors-v1.json](./vectors-v1.json).
The package ships it as `toiljs/auth/vectors-v1.json`, and builds copy it beside
this guide under `.toil/docs/auth/` so the relative link works locally.
It contains public test seeds and keys, intermediate values, complete signed
messages, signatures, and confirmation tags. The fixture is tested against the
JavaScript client, compiled ToilScript server helpers, and native Rust OPRF,
ML-DSA, ML-KEM, SHA-256, and HMAC implementations.

Regenerate it after building toiljs with `node scripts/gen-auth-vectors.mjs`.
All binary fields in the JSON are hexadecimal; timestamps are decimal strings.
The fixture's fixed timestamps and keys are for offline interoperability tests.

## Binary framing

HTTP bodies use `application/octet-stream`. All integers are unsigned,
**little-endian**. `bytes(x)` is `u32(byteLength) || x`; `str(s)` is
`bytes(UTF8(s))`. Strings are length-prefixed UTF-8, without a terminator.
These auth bodies do not have the four-byte `@data` class tag.

## Password and key derivation

1. Encode `NFKC(password)` as UTF-8. Do not trim, lowercase, or otherwise change it.
2. Use RFC 9497 **OPRF mode**, `ristretto255-SHA512`, not VOPRF or POPRF mode.
   The client generates a fresh blind and sends the 32-byte blinded element.
   The server derives its per-user OPRF key with `DeriveKeyPair(oprfSeed,
   UTF8(username))` and evaluates that element.
3. Finalize the OPRF using the normalized password bytes, saved blind, and
   evaluated element. Its 64-byte output is the **binary password input** to
   Argon2id; it is not hexadecimal text.
4. Run Argon2id with the server-issued salt, memory size in **KiB**, iteration
   count, parallelism, and a 32-byte output. The vector records each parameter.
5. Use those 32 output bytes as the ML-DSA-44 key-generation seed. Public keys
   are 1,312 bytes and signatures are 2,420 bytes. Do not send the password,
   OPRF output, Argon2 output, or signing secret key to the server.

## Registration

`POST /auth/register/start`:

```
request  = str(username) bytes(blinded)
response = u8(status) u32(memKiB) u32(iterations) u32(parallelism)
           bytes(salt) bytes(evaluated)
```

Continue only for status 0. Build the registration proof message:

```
u8(1) str(username) bytes(mldsaPublicKey)
```

Sign it with ML-DSA-44 and the separate FIPS 204 context
`qauth:register:v1`. Pass the context through the signature API; do not prepend
it to the message yourself.

`POST /auth/register/finish` sends:

```
str(username) str(email) bytes(mldsaPublicKey) bytes(registerSignature)
```

The response starts with a status byte. Status 0 means registration completed;
nonzero statuses are errors. Email confirmation may still be required by the
application. Initialize application records through the server-side
`AuthService.onRegistered` hook when appropriate.

## Login and server authentication

Pin the deployment's **ML-KEM-768 public key** in the native app's trusted
configuration. It is 1,184 bytes; never replace it with a key learned from an
untrusted login response.

`POST /auth/login/start`:

```
request  = str(username) bytes(blinded)
response = bytes(cid) str(audience)
           u32(memKiB) u32(iterations) u32(parallelism) bytes(salt)
           bytes(nonce) u64(iat) u64(exp) bytes(evaluated)
```

Finish the OPRF/KDF and regenerate the signing key. Encapsulate a fresh ML-KEM-768
secret to the pinned server public key. The ciphertext is 1,088 bytes; the shared
secret is 32 bytes. Compute `serverKemKeyId = SHA256(serverKemPublicKey)`.
Build the exact login message:

```
u8(1) str(username) str(audience) bytes(cid) bytes(nonce)
u64(iat) u64(exp) bytes(ciphertext)
u32(memKiB) u32(iterations) u32(parallelism) bytes(serverKemKeyId)
```

Sign with the separate context `qauth:login:v1`. Submit
`bytes(cid) bytes(ciphertext) bytes(signature)` to `/auth/login/finish`.
For status 0 or 3, its response is:

```
u8(status) bytes(first) bytes(serverConfirm)
```

Status 0 supplies the readable user codec bytes in `first`; status 3 supplies a
second-factor challenge identifier and creates no session. For **both** statuses,
verify server authentication before accepting a login or showing the 2FA prompt:

```
H = SHA256(loginMessage)
K = HMAC_SHA256(sharedSecret, UTF8("toil-session-key-v1") || H)
expected = HMAC_SHA256(K, UTF8("toil-server-confirm-v1") || H)
```

Compare `expected` to `serverConfirm` without an early exit on differing bytes.
Other status values represent failed credentials, confirmation requirements, or
other errors. Challenges are expiring and single-use; obtain a new challenge for
a retry.

## Sessions on native transports

The readable `first` value is **not a bearer credential**. Preserve the signed
HttpOnly session cookie from `Set-Cookie` in the platform's cookie jar and send
it on later requests to the same tenant. Over HTTPS its name is
`__Host-toil_sess`; the readable companion is `__Secure-toil_user`. Honor both
clearing cookies on logout or 401. The companion and decoded user bytes are for
display, and the server revalidates the signed cookie and revocation state.

## Initial stable identity

For a newly registered account, the user ID is SHA-256 over four `bytes(...)`
fields: UTF-8 `toil.userid.v1`, the ML-DSA public key, UTF-8 username, and the
configured identity domain. The vector includes this initial ID. The account
stores its ID so password/key changes preserve the existing identity; clients
should use the returned server identity rather than derive a replacement.
