# Data types (`@data`)

`@data` turns a plain class into a typed value that can travel safely between your frontend and your WASM backend, and in and out of the database, with both a binary and a JSON codec generated for you.

## What `@data` is

A **codec** is a pair of functions: one that turns a value into bytes (encode), and one that turns those bytes back into a value (decode). Any time data crosses a boundary (browser to server, server to database, one WASM call to another) it has to become bytes and back. Writing that by hand is tedious and easy to get wrong.

`@data` writes it for you. You declare a class with typed fields, tag it `@data`, and the compiler synthesizes a deterministic binary codec and a JSON codec on the class. The exact same class is also generated into your `shared/server.ts`, so the browser and the WASM backend agree on the format down to the byte.

```ts
@data
class Player {
    username: string = '';
    admin: bool = false;
    score: u64 = 0;
}
```

That is a complete, serializable type. Note every field has a **default value**; that is required (the generated decoder and the client constructor use it).

## Why and when

`@data` is the backbone of almost everything that moves in a toiljs app:

- **Request and response bodies** for [`@rest`](./rest.md) routes.
- **Arguments and return values** for [`@service` / `@remote`](./rpc.md) calls.
- **Values stored in [ToilDB](../database/README.md)**.
- **Sessions**, [stream](../realtime/README.md) messages, and any custom payload you design.

Whenever a route, an RPC method, or the database needs a structured value, that value is a `@data` class. You will define these constantly.

```mermaid
flowchart LR
    D["@data class<br/>(one definition)"] --> R["REST route body"]
    D --> P["RPC argument / result"]
    D --> B[("ToilDB value")]
    D --> S["Stream message"]
```

## What the compiler generates

From your `@data` class, the compiler adds these members:

| Member | What it does |
| --- | --- |
| `encode(): Uint8Array` | Serialize to bytes, with a 4-byte type-id prefix. |
| `static decode(buf): T` | Rebuild a value from bytes produced by `encode()`. |
| `encodeInto(w: DataWriter)` | Serialize without the type-id frame, for nesting inside another value. |
| `static decodeFrom(r: DataReader): T` | The matching read, for nested values. |
| `toJSON()` / `static fromJSON(v)` | The JSON codec (large integers become decimal strings, so `JSON.parse` keeps them exact). |
| `static dataId(): u32` | A stable hash (FNV-1a) of the class name, written as the type-id prefix. |

You mostly do not call these directly; routes, RPC, and the database call them for you. But they are there when you need them (for example `value.toJSON().toString()` to build a `Response.json`).

## Supported field types

A `@data` field may be:

- a scalar: `u8` through `u256`, `i8` through `i256`, `f32`, `f64`, `bool`;
- a `string`;
- a `Uint8Array` (a raw byte buffer);
- a nested `@data` class;
- an array `T[]` of any of the above.

For the number types (why `u64` is a `bigint` on the client, when to reach for `u256`, and so on), see [Types](../concepts/types.md).

Give every field a default. The layout is exactly the field declaration order (this matters, see [gotchas](#gotchas)).

## Nested `@data`, arrays, and bytes

`@data` classes compose. A field can be another `@data` class, an array, or a byte buffer, and it all encodes and decodes as one value:

```ts
@data
class Tag {
    label: string = '';
    weight: f32 = 0;
}

@data
class Document {
    id: u64 = 0;
    title: string = '';
    tags: Tag[] = [];            // array of nested @data
    authors: string[] = [];      // array of strings
    thumbnail: Uint8Array = new Uint8Array(0); // raw bytes
}
```

`Document.encode()` walks the whole tree: it writes `id`, `title`, each `Tag` (via `encodeInto`), each author string, and the raw `thumbnail` bytes, in field order. `Document.decode(bytes)` reads them back in the same order. On the JSON side, a `Uint8Array` field becomes a JSON array of byte numbers, and nested `@data` fields become nested JSON objects.

## Using `@data` in a route

A route's body parameter and its return value are `@data` values. Which codec runs depends on the route's stream mode (see [REST bodies](./rest.md#request-and-response-bodies)):

```ts
// JSON route (the default): body from JSON.parse, result via toJSON()
@post('/')
public create(input: NewPlayer): Player { /* ... */ }

// Binary route: body via decode(), result via encode()
@route({ method: Methods.POST, path: '/blob', stream: DataStream.Binary })
public blob(input: FileData): FileResult { /* ... */ }
```

- In a **JSON** route, the incoming body is `JSON.parse`d and revived with the type's `fromJSON`, and the returned value is serialized with `toJSON()`.
- In a **Binary** route, the incoming body is `decode`d and the returned value is `encode`d.

You do not call the codec yourself in either case; you just declare the types.

## The raw codec: `DataWriter` and `DataReader`

Sometimes you want to lay out bytes by hand: a custom body, a session token, a challenge message, a wire format someone else defined. For that, use the codec directly. It lives in the `data` module:

```ts
import { DataWriter, DataReader } from 'data';
```

This is the same codec `@data` classes are built from, and it has a byte-for-byte identical TypeScript version in `toiljs/io` (`src/io/codec.ts`), so your browser code can read and write the exact same bytes the WASM backend does.

### `DataWriter`

Every write method returns the writer, so calls chain.

| Method | Signature | Wire format |
| --- | --- | --- |
| `writeU8` / `writeI8` | `(v): DataWriter` | 1 byte |
| `writeU16` / `writeI16` | `(v): DataWriter` | 2 bytes, little-endian |
| `writeU32` / `writeI32` | `(v): DataWriter` | 4 bytes, LE |
| `writeU64` / `writeI64` | `(v): DataWriter` | 8 bytes, LE |
| `writeF32` / `writeF64` | `(v): DataWriter` | 4 / 8 bytes, IEEE-754 LE |
| `writeBool` | `(v): DataWriter` | 1 byte (`1` / `0`) |
| `writeBytes` | `(b: Uint8Array): DataWriter` | `u32` length (LE) + the raw bytes |
| `writeString` | `(s: string): DataWriter` | `u32` length (LE) + UTF-8 bytes |
| `writeU128` / `writeI128` | `(v): DataWriter` | two `u64` limbs (lo, hi) |
| `writeU256` / `writeI256` | `(v): DataWriter` | four `u64` limbs |
| `length` | `(): i32` | bytes written so far |
| `toBytes` | `(): Uint8Array` | an exact-length copy of the buffer |

### `DataReader`

Reads are **bounds-safe**: reading past the end of the buffer never crashes. Instead the read returns a zero or empty default and flips the reader's public `ok` flag to `false`. Check `ok` after a sequence of reads to catch a truncated or malformed buffer.

| Method | Signature | On over-read |
| --- | --- | --- |
| `readU8` / `readI8` | `(): integer` | `0` |
| `readU16`..`readU64`, `readI16`..`readI64` | `(): integer` | `0` |
| `readF32` / `readF64` | `(): float` | `0` |
| `readBool` | `(): bool` | `false` |
| `readBytes` | `(): Uint8Array` | empty array |
| `readString` | `(): string` | `""` |
| `readU128` / `readI128` / `readU256` / `readI256` | `(): bignum` | `0` |
| `remaining` | `(): i32` | bytes left unread |
| `ok` | `bool` (field) | `false` once any read over-ran |

### Encode and decode, both directions

```ts
import { DataWriter, DataReader } from 'data';

// Encode: a version byte, a name, a score, then a blob.
const out = new DataWriter()
    .writeU8(1)
    .writeString('alice')
    .writeU64(1234)
    .writeBytes(payload)
    .toBytes();

// Decode: read the fields back in the exact same order.
const r = new DataReader(out);
const version = r.readU8();
const name = r.readString();
const score = r.readU64();
const blob = r.readBytes();
if (!r.ok) return Response.badRequest('truncated');
```

The order of reads must match the order of writes exactly. The layout is the format.

## JSON vs binary: which to use

You usually pick this at the route level (see [REST bodies](./rest.md#request-and-response-bodies)), but the trade-off is the same everywhere:

- **JSON** is human-readable and understood by every tool. Pick it for endpoints a browser or a third party calls directly. Large integers ride as decimal strings so they stay exact.
- **Binary** is smaller, faster, and lossless for big numbers. Pick it for app-to-app traffic and anything performance sensitive. RPC always uses binary under the hood.

## Evolving a `@data` format: `@migrate`

Once records are stored, changing a `@data` **value** type is a problem: as the [gotchas](#gotchas) explain, the binary layout *is* the field order, so adding or changing a field means the bytes already on disk no longer match the new shape and would fail to decode. `@migrate` is how you evolve a stored type without a backfill and without downtime.

**What it is.** `@migrate` marks a plain (free) function that upgrades one record written under an **old** version of a value type into the **current** shape. The compiler weaves that function into the value type's decoder as a version dispatch: every stored record carries the schema version it was written under, so when a read hits an old record, the decoder decodes it as its old shape and runs your `@migrate` forward to today's shape. This happens **lazily**, per row, only when a record is actually read (nothing rewrites your whole collection up front).

**When to use it.** Any time you change a `@data` type that is already stored in ToilDB: you added a field, renamed one, changed a type. New writes use the new layout; old rows keep working because the migration upgrades them on the way out.

Here is the whole story. You shipped this value type:

```ts
// server/models/GuestEntry.ts  (version 1: what you shipped first)
@data
export class GuestEntry {
  author: string = '';
  message: string = '';
}
```

Later you add an `at` timestamp:

```ts
// server/models/GuestEntry.ts  (version 2: gained an `at` field)
@data
export class GuestEntry {
  author: string = '';
  message: string = '';
  at: u64 = 0;   // NEW field
}
```

Every entry already stored was written without `at`, so its bytes cannot decode as the new `GuestEntry`. You add a migration file to bridge them:

```ts
// server/migrations/GuestEntry.migration.ts
import { GuestEntry } from '../models/GuestEntry';

// Keep the ORIGINAL layout as its own class so old rows still decode.
// One kept class per past version.
@data
export class GuestEntryV1 {
  author: string = '';
  message: string = '';
}

// Upgrade a v1 row to the current GuestEntry. This is the DELTA form:
// (old, into). The compiler pre-copies the fields the two layouts share
// (author, message), so your body fills only what is new.
@migrate
export function up(old: GuestEntryV1, into: GuestEntry): void {
  into.at = 0; // unknown for entries written before the timestamp existed
}
```

That is it. Old entries now surface as fully-formed `GuestEntry` values with `at = 0`; new entries carry a real timestamp; the same read path serves both.

A `@migrate` function comes in two shapes, and you pick whichever reads better:

- **Delta form** `up(old: OldType, into: NewType): void` (used above). The compiler copies every field the two layouts share by name and type, and your body fills only the changed or new fields. Least to write when most fields carry over.
- **Full form** `up(old: OldType): NewType`. Your body builds and returns the whole new value itself. Use it when the transform is not a simple field-for-field copy.

```ts
// The same migration written in the full form.
@migrate
export function up(old: GuestEntryV1): GuestEntry {
  const e = new GuestEntry();
  e.author = old.author;
  e.message = old.message;
  e.at = 0;
  return e;
}
```

Gotchas specific to `@migrate`:

- **Location is enforced.** Every `@migrate` must live in a `migrations/<Type>.migration.ts` file (a `*.migration.ts` file under a `migrations/` folder). The build auto-discovers it (nothing imports it), and a `@migrate` placed anywhere else is a hard compile error, because it would silently never run.
- **A migration is a pure value transform.** It may not touch the database or any host service; it only turns old fields into new ones. Trying to read or write ToilDB from inside a `@migrate` is a compile error.
- **Migrations chain.** If you evolve a type more than once, keep one old class and one `@migrate` per step (`V0 -> V1`, `V1 -> V2`). The compiler walks the chain, so a row written under the oldest layout is carried all the way forward to the current shape, shortest path first.
- **When it actually runs.** On any read that decodes an old row (`get`, `getMany`, a view read, events `latest`). It also runs when a [`@derive`](../background/derive.md) rebuilds a view on box load and re-reads old stored events (see [Views](../database/views.md)).

## Dynamic JSON on the server: the `JSON` value tree

`@data` is for shapes you know ahead of time. Sometimes you do not: a webhook whose body varies, a third-party payload with optional fields, or a response you assemble on the fly. For those, toiljs gives you a `JSON` **value tree**: an in-memory value that can be a null, a bool, a number, a string, an array, or an object, which you read and build at runtime.

**What it is.** `JSON` is an ambient global class (no import needed). It represents one dynamic JSON value. `JSON.parse(text)` turns JSON text into one of these trees, and a `@data` class's `toJSON()` actually returns one too. It is the **untyped** counterpart to `@data`'s typed, fixed-shape codec: reach for `@data` when the shape is known and you want type safety, and for `JSON` when the shape is dynamic.

The statics that make a value:

| Static | What it does |
| --- | --- |
| `JSON.parse(text: string): JSON` | Parse JSON text into a value tree (returns an error value on malformed input). |
| `JSON.obj(): JSON` | A new empty object; fill it with `.set(key, value)`. |
| `JSON.arr(): JSON` | A new empty array; fill it with `.push(value)`. |
| `JSON.of<T>(value: T): JSON` | Wrap a scalar, string, bool, or array as a JSON value. |
| `JSON.nul(): JSON` | A JSON null. |
| `JSON.stringify<T>(value: T): string` | Serialize a scalar / string / bool / array value straight to a JSON string. |

The instance methods that read and build a value:

| Method | What it does |
| --- | --- |
| `.isObject()` / `.isArray()` / `.isString()` / `.isNumber()` / `.isBool()` / `.isNull(): bool` | Test the value's type before you read it. |
| `.has(key: string): bool` | Whether an object has `key`. |
| `.get(key: string): JSON` | The value for `key` on an object. |
| `.objectKeys(): Array<string>` | The keys of an object. |
| `.at(index: i32): JSON` | The element at `index` of an array. |
| `.length(): i32` | The element count of an array (0 otherwise). |
| `.asString(): string` | Read the value as a string. |
| `.asF64(): f64` / `.asI64(): i64` / `.asU64(): u64` | Read the value as a number. |
| `.asBool(): bool` | Read the value as a bool. |
| `.set(key: string, value: JSON): JSON` | Set a key on an object; returns `this`, so calls chain. |
| `.push(value: JSON): JSON` | Append to an array; returns `this`, so calls chain. |
| `.toString(): string` | Serialize this tree back to a JSON string. |

Reading an untyped body and building a reply, together:

```ts
import { Response, RouteContext } from 'toiljs/server/runtime';

@rest('echo')
class Echo {
  // POST /echo with an arbitrary JSON body we do not model as a @data class.
  @post('/')
  public handle(ctx: RouteContext): Response {
    const body = JSON.parse(ctx.text());   // ctx.text() is the raw body as text
    if (!body.isObject() || !body.has('name')) {
      return Response.badRequest('expected an object with a "name" field');
    }

    // Read fields out of the tree, guarding types and optional keys.
    const name = body.get('name').asString();
    const age = body.has('age') ? body.get('age').asI64() : 0;

    // Build a fresh JSON object to send back (chaining .set).
    const out = JSON.obj()
      .set('greeting', JSON.of<string>('hello, ' + name))
      .set('age', JSON.of<i64>(age));
    return Response.json(out.toString());
  }
}
```

Gotchas specific to `JSON`:

- **Check the type before you read.** `JSON.parse` never throws; a malformed input or a wrong-typed field yields an error or default value rather than a crash. Use `.isObject()` / `.has(...)` / `.isString()` and friends to validate untrusted input before you trust it.
- **It is a value tree, not a typed struct.** You get no compile-time field checking. When a shape is stable, prefer a `@data` class so the compiler catches typos and the client gets a typed type for free.
- **Big-integer care still applies.** As with any JSON, integers above 2^53 are best carried as strings; read them with `.asString()` when exactness matters.

## Gotchas

- **Field order is the format.** The binary layout is exactly your field declaration order. Reordering fields, or changing a field's type, is a breaking change: old bytes will decode wrong. To evolve a format safely, add new fields at the **end** (and, for hand-rolled payloads, bump a leading version byte).
- **Every field needs a default.** The generated decoder and the client constructor rely on it. A field with no default will not compile as `@data`.
- **`encode()` carries a type id; `encodeInto` does not.** The 4-byte `dataId()` prefix lets a decoder confirm it is reading the type it expected. When nesting one `@data` inside another, `encodeInto` / `decodeFrom` skip that frame (the outer type already identifies the whole value).
- **Endianness.** The WASM codec is little-endian. The `toiljs/io` codec defaults to little-endian too, and also accepts a per-call big-endian flag for network formats. Keep both ends on the same setting.
- **Plain JSON numbers lose precision above 2^53.** That is why `@data` sends 64-bit-and-larger integers as decimal strings over JSON. If you hand-build JSON, do the same, or use the binary codec.
- **`DataReader` never throws; check `ok`.** An over-read returns a default and sets `ok = false`. Always check `ok` after decoding untrusted bytes.

## Related

- [Types](../concepts/types.md): `u64`, `u256`, `f64`, and how each maps to `number` or `bigint`.
- [HTTP routes (`@rest`)](./rest.md): where `@data` bodies and return values are used, and the JSON vs binary route modes.
- [Typed RPC](./rpc.md): `@data` as RPC arguments and results, and the generated client classes.
- [The database](../database/README.md): storing `@data` values in ToilDB.
- [Backend overview](./README.md): where `@data` fits in the request lifecycle.
