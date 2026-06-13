# Data codec (`@data`)

`@data` turns a plain class into a typed, versionable value with a deterministic
binary codec and a JSON codec. It is the backbone of request/response bodies,
RPC arguments, sessions, and anything you persist. The same class becomes a
fully typed client type in the generated `shared/server.ts` (see
[RPC](./rpc.md)).

```ts
@data
class Player {
  username: string = '';
  admin: bool = false;
  score: u64 = 0;
}
```

From that the compiler synthesizes, on the class:

- `encode(): Uint8Array` / `static decode(buf): T` — the binary codec (with a
  4-byte type id prefix).
- `encodeInto(w: DataWriter)` / `static decodeFrom(r: DataReader)` — the codec
  without the type-id frame, for nesting.
- `toJSON()` / `static fromJSON(v)` — the JSON codec (64-bit-and-larger integers
  as decimal strings, so they survive `JSON.parse` exactly).
- `static dataId(): u32` — a stable FNV-1a hash of the class name, written as the
  type-id prefix by `encode()`.

Fields may be scalars (`u8`..`u256`, `i8`..`i256`, `f32`, `f64`, `bool`),
`string`, a nested `@data` class, or an array `T[]` of any of these. Give every
field a default; the generated decoder and the client constructor use them.

## Using `@data` in routes

In a **JSON** route, a `@data` parameter is revived from the parsed body and a
`@data` return value is serialized with `toJSON()`. In a **Binary** route, the
parameter is `decode`d from the raw body and the return value is `encode`d. The
route's stream mode (see [Routing](./routing.md#data-streams)) picks which.

```ts
@post('/')                       // JSON route
public create(input: NewPlayer): Player { /* input from JSON, Player to JSON */ }

@route({ method: Methods.POST, path: '/blob', stream: DataStream.Binary })
public blob(input: FileData): FileResult { /* input.decode, result.encode */ }
```

## The binary codec: `DataWriter` / `DataReader`

When you need to lay out bytes yourself — custom bodies, session payloads,
challenge messages — use the codec directly. It lives in the `data` module:

```ts
import { DataWriter, DataReader } from 'data';
```

The codec has a byte-for-byte identical TypeScript implementation in
`toiljs/io` (`src/io/codec.ts`), so the client can read and write the exact same
wire format the wasm guest does.

### `DataWriter`

Every writer method returns the writer for chaining.

| Method | Signature | Wire format |
| --- | --- | --- |
| `writeU8` / `writeI8` | `(v): DataWriter` | 1 byte |
| `writeU16` / `writeI16` | `(v): DataWriter` | 2 bytes, little-endian |
| `writeU32` / `writeI32` | `(v): DataWriter` | 4 bytes, LE |
| `writeU64` / `writeI64` | `(v): DataWriter` | 8 bytes, LE |
| `writeF32` / `writeF64` | `(v): DataWriter` | 4 / 8 bytes, IEEE-754 LE |
| `writeBool` | `(v): DataWriter` | 1 byte (`1`/`0`) |
| `writeBytes` | `(b: Uint8Array): DataWriter` | `u32` length (LE) + raw bytes |
| `writeString` | `(s: string): DataWriter` | `u32` length (LE) + UTF-8 bytes |
| `writeU128` / `writeI128` | `(v): DataWriter` | two `u64` limbs (lo, hi) |
| `writeU256` / `writeI256` | `(v): DataWriter` | four `u64` limbs (lo1, lo2, hi1, hi2) |
| `length` | `(): i32` | bytes written so far |
| `toBytes` | `(): Uint8Array` | an exact-length copy of the buffer |

### `DataReader`

Reads are bounds-safe: an over-read never traps. It returns a zero/empty default
and sets the public `ok` flag to `false`. Check `ok` after a sequence of reads
to detect a truncated or malformed buffer.

| Method | Signature | On over-read |
| --- | --- | --- |
| `readU8` / `readI8` | `(): u8 / i8` | `0` |
| `readU16`..`readU64`, `readI16`..`readI64` | `(): integer` | `0` |
| `readF32` / `readF64` | `(): f32 / f64` | `0` |
| `readBool` | `(): bool` | `false` |
| `readBytes` | `(): Uint8Array` | empty array |
| `readString` | `(): string` | `""` |
| `readU128`/`readI128`/`readU256`/`readI256` | `(): bignum` | `0` |
| `remaining` | `(): i32` | bytes left unread |
| `ok` | `bool` (field) | `false` once any read over-ran |

### Example

```ts
import { DataWriter, DataReader } from 'data';

// Write: u8 version, str name, u64 score, bytes blob
const out = new DataWriter()
  .writeU8(1)
  .writeString('alice')
  .writeU64(1234)
  .writeBytes(payload)
  .toBytes();

// Read it back
const r = new DataReader(out);
const version = r.readU8();
const name = r.readString();
const score = r.readU64();
const blob = r.readBytes();
if (!r.ok) return Response.badRequest('truncated');
```

## Notes

- **Endianness.** The AS guest codec is little-endian. The TypeScript `toiljs/io`
  codec defaults to little-endian and also accepts a per-call `be` flag for
  big-endian network formats; keep both ends on the same setting.
- **Field order is the format.** The binary layout is exactly the field
  declaration order. Reordering fields, or changing a type, is a breaking format
  change. Add new fields at the end and bump a leading version byte if you need
  to evolve a hand-rolled payload.
- **`encode()` carries a type id.** The 4-byte `dataId()` prefix lets a decoder
  confirm it is reading the type it expects. `encodeInto`/`decodeFrom` skip the
  frame for nesting one `@data` value inside another.
