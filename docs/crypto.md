# Web Crypto

The guest gets a synchronous Web Crypto surface through the ambient `crypto`
global, backed by host functions. It mirrors the browser `crypto` /
`crypto.subtle` API but **without Promises** — ToilScript has no `async`, so
every call returns its result directly. Keys are opaque per-request handles in a
host keystore; a `CryptoKey` is valid only for the request that created it.

```ts
const mac = crypto.hmacSha256(key, message); // Uint8Array
const id  = crypto.randomUUID();             // string
```

This is also what [`SecureCookies`](./cookies.md) and
[`AuthService`](./auth.md) are built on, so most apps use crypto indirectly.

## `crypto` namespace

Convenience helpers (all synchronous):

| Function | Signature | Notes |
| --- | --- | --- |
| `getRandomValues` | `(array: Uint8Array): void` | Fill with CSPRNG bytes. |
| `randomUUID` | `(): string` | RFC 4122 v4 UUID. |
| `sha1` / `sha256` / `sha384` / `sha512` | `(data: Uint8Array): Uint8Array` | One-shot digests. |
| `sha1Text` … `sha512Text` | `(s: string): Uint8Array` | UTF-8 encode then digest. |
| `hmacSha256` | `(key: Uint8Array, msg: Uint8Array): Uint8Array` | One-shot HMAC-SHA256. |
| `hmacSha256Text` | `(key: Uint8Array, msg: string): Uint8Array` | HMAC-SHA256 over a UTF-8 string. |
| `toHex` | `(bytes: Uint8Array): string` | Lowercase hex. |
| `subtle` | `SubtleCrypto` | The full primitive surface (below). |

## `crypto.subtle`

| Method | Signature |
| --- | --- |
| `digest` | `digest(algorithm: string, data: Uint8Array): Uint8Array` |
| `importKey` | `importKey(format: string, keyData: Uint8Array, algorithm: AlgorithmParams, extractable: bool, usages: i32): CryptoKey` |
| `exportKey` | `exportKey(format: string, key: CryptoKey): Uint8Array` |
| `encrypt` | `encrypt(algorithm: AlgorithmParams, key: CryptoKey, data: Uint8Array): Uint8Array` |
| `decrypt` | `decrypt(algorithm: AlgorithmParams, key: CryptoKey, data: Uint8Array): Uint8Array` |
| `sign` | `sign(algorithm: AlgorithmParams, key: CryptoKey, data: Uint8Array): Uint8Array` |
| `verify` | `verify(algorithm: AlgorithmParams, key: CryptoKey, signature: Uint8Array, data: Uint8Array): bool` |
| `deriveBits` | `deriveBits(algorithm: AlgorithmParams, baseKey: CryptoKey, length: i32): Uint8Array` |
| `deriveKey` | `deriveKey(algorithm, baseKey, lengthBits, derivedKeyAlgorithm, extractable, usages): CryptoKey` |

`digest` takes a named algorithm string (`"SHA-1"`, `"SHA-256"`, `"SHA-384"`,
`"SHA-512"`, `"SHA3-256"`, `"SHA3-384"`, `"SHA3-512"`). `verify` returns a bool
(it does not throw on a mismatch). Formats are `raw`, `pkcs8`, `spki`; **`jwk`
is not supported**.

### Algorithm parameter classes

`crypto` and `crypto.subtle` are ambient globals (no import). The params classes
and the `ALG_*` / `USAGE_*` / `FMT_*` / `CURVE_*` constants and the `CryptoKey`
type are imported from the `'crypto'` module:

```ts
import { AesGcmParams, HmacImportParams, ALG_SHA_256, USAGE_SIGN } from 'crypto';
```

Each algorithm has a small params class you pass to `importKey`/`sign`/etc.:

| Class | Constructor |
| --- | --- |
| `AesGcmParams` | `(iv, additionalData?, tagLength = 128)` |
| `AesCbcParams` | `(iv)` |
| `AesCtrParams` | `(counter, length = 128)` |
| `HmacImportParams` | `(hash)` |
| `HmacParams` | `()` |
| `Pbkdf2Params` | `(hash, salt, iterations)` |
| `HkdfParams` | `(hash, salt, info?)` |
| `EcdsaParams` | `(hash)` |
| `EcKeyImportParams` | `(alg, namedCurve)` |
| `Ed25519Params` | `()` |
| `X25519ImportParams` | `()` |
| `EcdhParams` | `(alg, publicKeyHandle)` |

### Constants

- **Hashes / algorithms:** `ALG_SHA_1`, `ALG_SHA_256`, `ALG_SHA_384`,
  `ALG_SHA_512`, `ALG_SHA3_256/384/512`, `ALG_AES_GCM`, `ALG_AES_CBC`,
  `ALG_AES_CTR`, `ALG_HMAC`, `ALG_ECDSA`, `ALG_ED25519`, `ALG_ECDH`, `ALG_HKDF`,
  `ALG_PBKDF2`.
- **Key formats:** `FMT_RAW`, `FMT_PKCS8`, `FMT_SPKI` (`FMT_JWK` is rejected).
- **Usages (bitmask):** `USAGE_ENCRYPT`, `USAGE_DECRYPT`, `USAGE_SIGN`,
  `USAGE_VERIFY`, `USAGE_DERIVE_KEY`, `USAGE_DERIVE_BITS`, `USAGE_WRAP_KEY`,
  `USAGE_UNWRAP_KEY` — OR them together.
- **Named curves:** `CURVE_P256`, `CURVE_P384` (`CURVE_P521` is not supported).

### `CryptoKey`

An opaque handle plus metadata: `handle: i32`, `type: string`
(`secret`/`public`/`private`), `extractable: bool`, `algorithm: i32`,
`usages: i32`, with `algorithmName()` and `hasUsage(u)`. A key is valid only for
the request that imported it.

## Examples

HMAC-SHA256 (one-shot):

```ts
const mac = crypto.hmacSha256(key, message);
const hex = crypto.toHex(mac);
```

AES-256-GCM via `subtle`:

```ts
const key = new Uint8Array(32); crypto.getRandomValues(key);
const iv  = new Uint8Array(12); crypto.getRandomValues(iv);

const k  = crypto.subtle.importKey('raw', key, new AesGcmParams(iv, aad, 128), false, USAGE_ENCRYPT);
const ct = crypto.subtle.encrypt(new AesGcmParams(iv, aad, 128), k, plaintext);
```

## Post-quantum verify

The host also exposes ML-DSA-44 (FIPS 204) signature verification as
`crypto.mldsa_verify`. It is verify-only — the host never holds a secret key — and
underpins the [auth primitive](./auth.md). Most code reaches it through
`AuthService.verifyLogin(publicKey, message, signature)` rather than calling the
import directly. Public key is 1312 bytes, signature 2420 bytes, with a FIPS 204
domain-separation context.

## Limitations

- **No Promises** — every call is synchronous.
- **No RSA** and **no JWK** key format.
- **P-521** is not supported (P-256 and P-384 are).
- Signature *generation* for ML-DSA is client-side only; the server verifies.
