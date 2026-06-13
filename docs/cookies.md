# Cookies

A complete HTTP cookie layer for the toiljs server runtime, covering the full
RFC 6265bis surface (including `SameSite`, the `Partitioned`/CHIPS attribute, and
the `__Host-` / `__Secure-` prefixes) plus cryptographic signing and encryption.

`Cookie`, `Cookies`, `CookieMap`, `SecureCookies`, and the `SameSite` /
`CookieEncoding` / `CookiePrefix` enums are **ambient globals**: a handler uses
them with **no import**, exactly like `crypto`. They are also exported from
`toiljs/server/runtime` for anyone who prefers an explicit import.

- [How "global, no import" works](#how-global-no-import-works)
- [Quick start](#quick-start)
- [The `Cookie` builder](#the-cookie-builder)
- [The `Cookies` parser and codec](#the-cookies-parser-and-codec)
- [`CookieMap`](#cookiemap)
- [`SecureCookies` signing and encryption](#securecookies-signing-and-encryption)
- [`Request` and `Response` integration](#request-and-response-integration)
- [`base64url` helpers](#base64url-helpers)
- [Encoding vs encryption](#encoding-vs-encryption)
- [Security notes](#security-notes)
- [Spec compliance](#spec-compliance)
- [Testing](#testing)
- [API reference](#api-reference)

---

## How "global, no import" works

The cookie types are declared with ToilScript's `@global` decorator and pulled
into every server build (re-exported from `toiljs/server/runtime` and
side-effect-imported by `toiljs/server/runtime/exports`, which every `main.ts`
re-exports). At compile time the symbols register in the global scope, so a
handler can write `Cookie.create(...)` or `req.cookie(...)` without importing
anything.

For the editor, `toiljs create` scaffolds `server/toil-server-env.d.ts` with
ambient `declare`s for these globals (the toilscript compiler ignores `.d.ts`;
it only feeds the language service). If you would rather import them:

```ts
import { Cookie, Cookies, SecureCookies, SameSite } from 'toiljs/server/runtime';
```

---

## Quick start

```ts
import { ToilHandler, Request, Response } from 'toiljs/server/runtime';

export class AppHandler extends ToilHandler {
    public handle(req: Request): Response {
        // Read (no import needed for Cookie / Cookies / SameSite, they are global).
        const sid = req.cookie('sid'); // string | null

        // Write a hardened session cookie.
        return Response.json('{"ok":true}').setCookie(
            Cookie.create('sid', 'abc123')
                .httpOnly()
                .secure()
                .sameSite(SameSite.Lax)
                .maxAge(3600)
                .asHostPrefixed(), // forces Secure + Path=/ + no Domain
        );
    }
}
```

---

## The `Cookie` builder

A fluent builder that serializes to one `Set-Cookie` field value. Every setter
returns the cookie, so calls chain.

```ts
const c = Cookie.create('id', 'abc123')
    .domain('example.com')
    .path('/app')
    .maxAge(3600)
    .secure()
    .httpOnly()
    .sameSite(SameSite.Lax);

c.serialize();
// "id=abc123; Domain=example.com; Path=/app; Max-Age=3600; SameSite=Lax; Secure; HttpOnly"
```

### Fields

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | The cookie name (a token; never encoded). |
| `value` | `string` | The logical value (encoded per `encoding` on serialize). |
| `encoding` | `CookieEncoding` | Wire encoding for the value. Default `Percent`. |

### Construction

- `new Cookie(name, value)`
- `Cookie.create(name, value): Cookie`, a builder-style alias.

### Attribute setters

| Method | Attribute |
| --- | --- |
| `domain(v: string)` | `Domain` |
| `path(v: string)` | `Path` (must begin with `/`) |
| `maxAge(seconds: i64)` | `Max-Age` (`0` / negative expire immediately) |
| `expires(epochSeconds: i64)` | `Expires`, formatted as an IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) |
| `expiresRaw(date: string)` | `Expires` verbatim (escape hatch) |
| `secure(on: bool = true)` | `Secure` |
| `httpOnly(on: bool = true)` | `HttpOnly` |
| `sameSite(s: SameSite)` | `SameSite` |
| `partitioned(on: bool = true)` | `Partitioned` (CHIPS) |
| `priority(p: string)` | `Priority` (`Low` / `Medium` / `High`) |
| `extension(av: string)` | An arbitrary extension attribute, appended verbatim |
| `withEncoding(e: CookieEncoding)` | Choose the value wire encoding |

### Prefixes

- `asSecurePrefixed(): Cookie`, prepends `__Secure-` and forces `Secure`.
- `asHostPrefixed(): Cookie`, prepends `__Host-` and forces `Secure`, `Path=/`, and no `Domain`.
- `detectedPrefix(): CookiePrefix`, the prefix detected on the current name (case-insensitive).

### Output

- `serialize(strict: bool = false): string`, returns the `Set-Cookie` value. Lenient by
  default (always returns a best-effort cookie); pass `strict = true` to throw on
  a hard validation failure. `Secure` is added automatically when `SameSite=None`
  or `Partitioned` is set; `Max-Age` is clamped to the 400-day cap; control
  characters are stripped from the name, value, and attributes.
- `toString(): string`, alias for `serialize()`.
- `encodedValue(): string`, the value transformed per `encoding`.

### Validation

`validate(): CookieValidation` checks the cookie against RFC 6265bis and returns
a structured result:

```ts
class CookieValidation {
    valid: bool;
    errors: Array<string>;
}
```

It flags: a non-token name, name+value over 4096 bytes, a `Domain`/`Path` over
1024 bytes, a `Path` not starting with `/`, a `Raw` value outside `cookie-octet`,
the `__Host-` / `__Secure-` prefix requirements, `SameSite=None` or `Partitioned`
without `Secure`, and a `Max-Age` beyond the 400-day cap.

### Attribute serialization order

`name=value` then, when set: `Domain`, `Path`, `Expires`, `Max-Age`, `SameSite`,
`Secure`, `HttpOnly`, `Partitioned`, `Priority`, then any `extension(...)` values.
(Attribute order is not significant to user agents; the order is stable so output
is predictable.)

### Enums

```ts
enum SameSite { Default, None, Lax, Strict }      // Default omits the attribute
enum CookieEncoding { Percent, Raw, Base64Url }   // value wire encoding
enum CookiePrefix { None, Secure, Host }
```

---

## The `Cookies` parser and codec

Static helpers for the read side and a one-shot serializer.

| Method | Description |
| --- | --- |
| `Cookies.parse(cookieHeader: string): CookieMap` | Parse a request `Cookie` header (`a=1; b=2`). Values are percent-decoded; one layer of surrounding quotes is stripped; malformed pairs and empty names are skipped. On a duplicate name the first wins. |
| `Cookies.get(cookieHeader: string, name: string): string \| null` | Parse and return one value. |
| `Cookies.serialize(name: string, value: string): string` | One-shot `name=value` with no attributes (percent-encoded). For attributes, build a `Cookie`. |
| `Cookies.parseSetCookie(setCookie: string): Cookie` | Parse a `Set-Cookie` line back into a `Cookie` (for clients, tests, proxies). Kept verbatim (`CookieEncoding.Raw`) so re-serializing reproduces the wire form. |
| `Cookies.encodeValue(raw: string): string` | Percent-encode a value (the default `Cookie` encoding). |
| `Cookies.decodeValue(enc: string): string` | Percent-decode a value (the inverse). |

```ts
const jar = Cookies.parse('sid=abc123; theme=dark');
jar.get('sid'); // "abc123"

Cookies.serialize('sid', 'a b'); // "sid=a%20b"
```

---

## `CookieMap`

The ordered name to value view returned by `Cookies.parse` and `Request.cookies()`.
Backed by parallel arrays (a request carries a handful of cookies, so a linear
scan beats hashing and keeps the runtime small).

| Member | Description |
| --- | --- |
| `get(name: string): string \| null` | The value, or `null`. |
| `has(name: string): bool` | Whether the cookie is present. |
| `names(): Array<string>` | A copy of the names, in encounter order. |
| `size: i32` | The number of cookies. |
| `set(name: string, value: string): void` | Insert unless present (keep-first). Used by `parse`; rarely called directly. |

---

## `SecureCookies` signing and encryption

Tamper-proof and confidential cookie values, built on the `crypto` global (no new
host functions).

- **`SecureCookies.signed(key)`**: HMAC-SHA256. The value stays readable but is
  bound to the cookie name, so it cannot be tampered with or moved to another
  cookie. Sealed form: `base64url(value) "." base64url(mac)`.
- **`SecureCookies.encrypted(key)`**: AES-256-GCM (or AES-128-GCM) with a random
  96-bit IV and the cookie name as additional authenticated data. The value is
  confidential and authenticated. Sealed form: `base64url(iv ‖ ciphertext ‖ tag)`.

Keys are caller-supplied raw bytes:

- HMAC: any length (32+ bytes recommended).
- AES: exactly 16 or 32 bytes (enforced up front; a wrong length is rejected by
  the factory).

```ts
// A real app loads a long random secret from config; never hard-code one.
const key = Uint8Array.wrap(String.UTF8.encode('0123456789abcdef0123456789abcdef'));

// Signed (readable, tamper-proof)
const signer = SecureCookies.signed(key);
const sealed = signer.sign('session', 'user-42');
const user = signer.unsign('session', sealed); // "user-42", or null if tampered

// Encrypted (confidential + authenticated)
const box = SecureCookies.encrypted(key);
resp.setCookie(box.seal(Cookie.create('secret', 'top-secret').httpOnly()));
const secret = box.open(req.cookies(), 'secret'); // "top-secret", or null
```

| Method | Description |
| --- | --- |
| `SecureCookies.signed(key: Uint8Array)` | HMAC-SHA256 signer/verifier. |
| `SecureCookies.encrypted(key: Uint8Array)` | AES-GCM (16- or 32-byte key). |
| `addKey(key: Uint8Array): SecureCookies` | Add a fallback key for rotation: seal with the first, open with any. |
| `sign(name, value): string` | Sealed signed value. |
| `unsign(name, sealed): string \| null` | Verify and recover, or `null`. |
| `encrypt(name, value): string` | Sealed encrypted value. |
| `decrypt(name, sealed): string \| null` | Decrypt, or `null`. |
| `seal(cookie: Cookie): Cookie` | Seal a cookie's value in place (sign or encrypt per the instance mode) and mark it `Raw`. Returns the same cookie. |
| `open(jar: CookieMap, name): string \| null` | Read and open cookie `name` from a parsed jar. |

**Key rotation:** seal with `keys[0]`; `unsign` / `decrypt` try every key in turn,
so you can add a new key as the first and keep an old one as a fallback while
existing cookies age out.

```ts
const signer = SecureCookies.signed(newKey).addKey(oldKey);
```

---

## `Request` and `Response` integration

Because every handler already has a `Request` and returns a `Response`, the most
common operations live there directly.

**Read (`Request`):**

| Method | Description |
| --- | --- |
| `req.cookies(): CookieMap` | All cookies, parsed from the `Cookie` header (cached for the request). |
| `req.cookie(name: string): string \| null` | One cookie value. |

**Write (`Response`, builder-style):**

| Method | Description |
| --- | --- |
| `resp.setCookie(cookie: Cookie): Response` | Append a `Set-Cookie`. Each call adds its own header (cookies are never folded). |
| `resp.setCookieKV(name, value): Response` | Shorthand for `setCookie(new Cookie(name, value))`. |
| `resp.clearCookie(name, path = '/', domain = ''): Response` | Append a deletion cookie (empty value, `Max-Age=0`, epoch `Expires`). `path` / `domain` must match the original. |

---

## `base64url` helpers

Unpadded base64url (RFC 4648 §5), used internally by `SecureCookies` and exported
for convenience. Its alphabet (`A-Z a-z 0-9 - _`) is within the `cookie-octet`
grammar and invariant under percent-encoding, so encoded values round-trip
cleanly through the default cookie codec.

| Function | Description |
| --- | --- |
| `base64UrlEncode(data: Uint8Array): string` | Encode bytes as unpadded base64url. |
| `base64UrlDecode(s: string): Uint8Array \| null` | Decode base64url/base64 (padding and whitespace tolerated); `null` on an invalid character or length. |

---

## Encoding vs encryption

Two independent layers, easy to mix up:

- **Encoding** (`CookieEncoding`) is transport-only and reversible by anyone. It
  keeps an arbitrary value inside the `cookie-octet` grammar.
  - `Percent` (default): `encodeURIComponent`-style; arbitrary UTF-8 is safe.
  - `Base64Url`: UTF-8 then base64url.
  - `Raw`: no transformation (the value must already be valid `cookie-octet`).
- **Signing / encryption** (`SecureCookies`) is cryptographic. Signing keeps the
  value readable but tamper-proof; encryption makes it unreadable and
  authenticated. Both require a secret key.

`SecureCookies.seal` sets the value to its sealed (base64url) form and marks the
cookie `Raw`, so it passes through the default parse path untouched.

---

## Security notes

- **Panic-free verification.** `unsign` and `decrypt` return `null` on a tampered,
  truncated, or wrong-key value, never a trap. (`decrypt` reads the host return
  code directly instead of letting the underlying crypto throw, because the
  server runs with exceptions disabled.) This makes them safe to call on
  attacker-controlled input.
- **Name-binding.** Signing MACs `name + "=" + value`; encryption uses the name as
  AAD. A sealed value made for one cookie name will not verify or decrypt under
  another.
- **Control characters are stripped** from the name, value, and attribute values
  on serialize, as a defense-in-depth guard against header injection (CR/LF).
  Control characters are invalid in all of these per the grammar, so nothing
  legitimate is lost. The default value encoding already neutralizes CR/LF.
- **Prefixes.** `asHostPrefixed()` / `asSecurePrefixed()` apply and enforce the
  browser-recognized guarantees; `validate()` reports a name that carries a prefix
  without satisfying its requirements.
- **`SameSite=None` and `Partitioned` imply `Secure`** and are emitted with it
  automatically.
- **Lifetime is clamped** to the RFC 400-day cap on serialize; sizes are checked by
  `validate()`.
- **Local development.** Browsers treat `http://localhost` as a secure context, so
  `Secure` and `__Host-` cookies work under `toiljs dev` over plain HTTP.

When putting untrusted input into a cookie **name** or **attribute** (rather than
the value, which is encoded by default), check `validate()` or use
`serialize(true)`.

---

## Spec compliance

Implements RFC 6265bis (HTTP State Management) and the `Partitioned` (CHIPS)
companion: the `cookie-name` token and `cookie-value` `cookie-octet` grammars,
the `Expires` / `Max-Age` / `Domain` / `Path` / `Secure` / `HttpOnly` /
`SameSite` / `Partitioned` attributes plus `Priority` and arbitrary extensions,
the `__Host-` / `__Secure-` prefixes (matched case-insensitively), the 4096-byte
name+value and 1024-byte attribute limits, the 400-day lifetime cap, the
`SameSite=None` ⇒ `Secure` rule, and the requirement that each cookie occupy its
own `Set-Cookie` header (never folded).

---

## Testing

- Pure cookie logic (builder, parser, codec, validation, `Request` / `Response`
  integration) is unit-tested with as-pect in `test/assembly/cookie.spec.ts`
  (`npm run test:server`).
- `SecureCookies` is exercised end-to-end against the real toilscript-compiled
  wasm with the Node-backed crypto host in `test/devserver.test.ts`
  (`npm test`). It is tested there rather than under as-pect because the as-pect
  compiler does not ship the toilscript crypto standard library.

A live demo (every attribute's serialized output, set/inspect/clear, and an
interactive sign/encrypt) is in the example app: run `toiljs dev` in
`examples/basic` and open `/cookies`. The backend lives in
`examples/basic/server/core/AppHandler.ts`.

---

## API reference

```ts
// Globals (also exported from 'toiljs/server/runtime')

enum SameSite { Default, None, Lax, Strict }
enum CookieEncoding { Percent, Raw, Base64Url }
enum CookiePrefix { None, Secure, Host }

class CookieValidation {
    valid: bool;
    errors: Array<string>;
}

class Cookie {
    name: string;
    value: string;
    encoding: CookieEncoding;
    static create(name: string, value: string): Cookie;
    domain(v: string): Cookie;
    path(v: string): Cookie;
    maxAge(seconds: i64): Cookie;
    expires(epochSeconds: i64): Cookie;
    expiresRaw(date: string): Cookie;
    secure(on?: bool): Cookie;
    httpOnly(on?: bool): Cookie;
    sameSite(s: SameSite): Cookie;
    partitioned(on?: bool): Cookie;
    priority(p: string): Cookie;
    extension(av: string): Cookie;
    withEncoding(e: CookieEncoding): Cookie;
    asSecurePrefixed(): Cookie;
    asHostPrefixed(): Cookie;
    detectedPrefix(): CookiePrefix;
    encodedValue(): string;
    validate(): CookieValidation;
    serialize(strict?: bool): string;
    toString(): string;
}

class CookieMap {
    get(name: string): string | null;
    has(name: string): bool;
    names(): Array<string>;
    size: i32;
    set(name: string, value: string): void;
}

class Cookies {
    static parse(cookieHeader: string): CookieMap;
    static get(cookieHeader: string, name: string): string | null;
    static serialize(name: string, value: string): string;
    static parseSetCookie(setCookie: string): Cookie;
    static encodeValue(raw: string): string;
    static decodeValue(enc: string): string;
}

class SecureCookies {
    static signed(key: Uint8Array): SecureCookies;
    static encrypted(key: Uint8Array): SecureCookies;
    addKey(key: Uint8Array): SecureCookies;
    sign(name: string, value: string): string;
    unsign(name: string, sealed: string): string | null;
    encrypt(name: string, value: string): string;
    decrypt(name: string, sealed: string): string | null;
    seal(cookie: Cookie): Cookie;
    open(jar: CookieMap, name: string): string | null;
}

function base64UrlEncode(data: Uint8Array): string;
function base64UrlDecode(s: string): Uint8Array | null;

// On Request
req.cookies(): CookieMap;
req.cookie(name: string): string | null;

// On Response (builder-style)
resp.setCookie(cookie: Cookie): Response;
resp.setCookieKV(name: string, value: string): Response;
resp.clearCookie(name: string, path?: string, domain?: string): Response;
```
