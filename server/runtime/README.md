# toiljs server runtime

In-tree SDK that bridges a toilscript handler to the toil-backend
edge's wasm ABI.

## What it does

The edge calls `handle(req_ofs: i32, req_len: i32) -> i64` on every
request. This runtime gives you:

- `Request` / `Response` AssemblyScript types
- A byte-for-byte envelope codec matching
  `toil-backend/src/http/envelope.rs`
- A `ToilHandler` base class you extend, plus a `Server` singleton you
  assign `Server.handler = () => new MyHandler()`. The `handle` wasm
  export (re-exported from `toiljs/server/runtime/exports`) decodes the
  request, runs your handler, encodes the response, and returns the
  packed i64 the host expects.

## Cookies

A complete HTTP cookie layer (RFC 6265bis, including `SameSite`, `Partitioned`/CHIPS,
and the `__Host-` / `__Secure-` prefixes). `Cookie`, `Cookies`, and `SecureCookies`
are ambient globals, usable in a handler with **no import**, exactly like `crypto`.

Read:

```ts
const sid = req.cookie('sid');   // string | null
const jar = req.cookies();       // CookieMap: get / has / names / size
```

Write (the builder hangs off `Response`; every attribute is a chained setter):

```ts
return Response.json('{"ok":true}').setCookie(
    Cookie.create('sid', token)
        .httpOnly()
        .secure()
        .sameSite(SameSite.Lax)
        .maxAge(3600)
        .asHostPrefixed(),       // forces Secure, Path=/, no Domain
);

resp.clearCookie('sid');         // expires it (Max-Age=0 + epoch Expires)
```

Each `setCookie` emits its own `Set-Cookie` header (cookies are never folded). The
builder covers `domain`, `path`, `maxAge`, `expires` (epoch seconds, rendered as an
IMF-fixdate) / `expiresRaw`, `secure`, `httpOnly`, `sameSite`, `partitioned`,
`priority`, and arbitrary `extension(...)`. `SameSite=None` and `Partitioned` imply
`Secure`, and `Max-Age` is clamped to the 400-day cap. `cookie.validate()` returns a
structured result; `cookie.serialize(true)` throws on a hard violation. Values are
percent-encoded by default (arbitrary UTF-8 is safe), switchable with
`.withEncoding(CookieEncoding.Raw)` or `CookieEncoding.Base64Url`.

Parse and serialize the request side:

```ts
const jar = Cookies.parse('a=1; b=2');                // CookieMap
const one = Cookies.get(header, 'a');                 // string | null
const line = Cookies.serialize('a', 'b');             // 'a=b'
const cookie = Cookies.parseSetCookie(setCookieLine); // Set-Cookie -> Cookie
```

Signed and encrypted values with `SecureCookies`, built on the `crypto` global. Keys
are caller-supplied raw bytes (HMAC: any length, AES: 16 or 32 bytes); add more for
rotation. Verification and decryption never throw on bad input, a tampered or
truncated value returns `null`:

```ts
const signer = SecureCookies.signed(key);    // HMAC-SHA256: readable, bound to the cookie name
const sealed = signer.sign('session', userId);
const id = signer.unsign('session', sealed); // string | null

const box = SecureCookies.encrypted(key);    // AES-256-GCM: confidential + authenticated
resp.setCookie(box.seal(Cookie.create('session', userId).httpOnly()));
const open = box.open(req.cookies(), 'session'); // string | null
```

## Wire contract

Source of truth: `toil-backend/src/http/envelope.rs`.

```
request envelope (LE, no padding):
  u8   method      0=GET 1=POST 2=PUT 3=DELETE 4=PATCH 5=HEAD 6=OPTIONS
  u16  path_len
  [u8] path
  u16  n_headers
  for each header: u16 name_len, u16 val_len, [u8] name, [u8] val
  u32  body_len
  [u8] body
```

The response envelope is the same shape with the first `u8 method +
u16 path_len + path` replaced by `u16 status`.

The handler must return a packed `i64`:

```
(resp_ofs << 32) | resp_len
```

The host reads `resp_len` bytes starting at `resp_ofs` in linear
memory and decodes them as a response envelope.

## Memory layout

- `[0, req_len)` — request envelope, written by the host before
  `handle` is called.
- `[65536, 65536 + resp_len)` — response envelope, written by
  `dispatch` (the response base is the second 64 KiB page so the
  request and response never overlap).

The edge enforces a 1024-page (64 MiB) linear memory cap via
`LimitingTunables`, so leaving the first page for the request is
fine.

## Example

A user app extends `ToilHandler` and wires it up in `server/main.ts`.
The runtime is consumed as the `toiljs/server/runtime` library export:

```ts
// server/HelloHandler.ts
import { ToilHandler, Request, Response } from 'toiljs/server/runtime';

export class HelloHandler extends ToilHandler {
    public handle(req: Request): Response {
        if (req.path == '/') return Response.text('hello\n');
        if (req.path == '/json') return Response.json('{"ok":true}');
        return Response.notFound();
    }
}
```

```ts
// server/main.ts
import { Server } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import { HelloHandler } from './HelloHandler';

Server.handler = () => new HelloHandler();

// Surface the wasm `handle(i32, i32) -> i64` entry the edge calls.
export * from 'toiljs/server/runtime/exports';

// Forward AS runtime panics to the host's env::abort import.
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
```

Compile with `toilscript --target release`, drop the resulting
`build/server/release.wasm` at `<toil-backend>/hosts/<hostname>.wasm`,
and the edge will route requests with that `Host:` header to it. A
complete app lives in `examples/basic`.
