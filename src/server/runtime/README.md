# toiljs server runtime

In-tree SDK that bridges a toilscript handler to the toil-backend
edge's wasm ABI.

## What it does

The edge calls `handle(req_ofs: i32, req_len: i32) -> i64` on every
request. This runtime gives you:

- `Request` / `Response` AssemblyScript types
- A byte-for-byte envelope codec matching
  `toil-backend/src/http/envelope.rs`
- A `dispatch(handler, req_ofs, req_len)` helper that decodes the
  request, runs the user's handler, encodes the response, and returns
  the packed i64 the host expects.

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

```ts
// src/server/main.ts
import { dispatch, Response } from './runtime';

export function handle(req_ofs: i32, req_len: i32): i64 {
  return dispatch((req) => {
    if (req.path == "/")     return Response.text("hello\n");
    if (req.path == "/json") return Response.json("{\"ok\":true}");
    return Response.notFound();
  }, req_ofs, req_len);
}
```

Compile with `npm run build:server`, drop
`build/server/release.wasm` at
`/root/toil-backend/hosts/<hostname>.wasm`, and the edge will route
requests with that `Host:` header to it.
