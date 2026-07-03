# The server type system

Your backend is TypeScript, but a stricter, faster dialect of it. Numbers have an exact bit width (`u32`, `i64`, `f64`, and friends) instead of one loose `number`, and a few TypeScript features do not exist. This page explains the types you write in `server/` code.

## Why the server types are different

Your frontend TypeScript runs in a browser, where a JavaScript engine figures out types as it goes. Your **server** code is different: the **toilscript** compiler turns it into [WebAssembly](../backend/README.md) (WASM), a compact machine-like binary. To emit that binary, the compiler must know the *exact* size of every value ahead of time. "A number" is not enough; it needs to know "a 32-bit unsigned integer" so it can pick the right machine instruction and lay out memory.

toilscript is built on **AssemblyScript**, a strict subset of TypeScript designed to compile to WASM. So the server language looks and reads like TypeScript, but every number is a fixed-width type, and there is no room for the fuzzy parts of JavaScript. The payoff is speed and safety: your code compiles to something close to hand-written native code, and whole classes of bugs cannot occur.

You already know the syntax. You only need to learn the number types and a handful of rules.

## The number types

There is no plain `number` in server code. Instead you pick the exact type. The name tells you three things: signed or unsigned, how many bits, integer or float.

- The letter: `u` = unsigned integer (zero and up), `i` = signed integer (can be negative), `f` = floating-point (has a fractional part).
- The number: how many bits wide it is.

| Type | Kind | Bits | Range | Use it for |
| --- | --- | --- | --- | --- |
| `bool` | boolean | 1 | `true` / `false` | flags, yes/no |
| `u8` | unsigned int | 8 | 0 to 255 | a byte, a small enum |
| `u16` | unsigned int | 16 | 0 to 65,535 | ports, small counts |
| `u32` | unsigned int | 32 | 0 to ~4.29 billion | sizes, ids, most counts |
| `u64` | unsigned int | 64 | 0 to ~1.8e19 | timestamps (ms), big counters, large ids |
| `i8` | signed int | 8 | -128 to 127 | tiny signed values |
| `i16` | signed int | 16 | -32,768 to 32,767 | small signed values |
| `i32` | signed int | 32 | ~-2.1 to 2.1 billion | the default integer; loop counters, deltas |
| `i64` | signed int | 64 | ~-9.2e18 to 9.2e18 | large signed counts, database counters |
| `f32` | float | 32 | ~7 decimal digits | low-precision decimals (rare) |
| `f64` | float | 64 | ~15-16 decimal digits | any value with a fraction: prices, ratios, math |

There are also 128-bit and 256-bit integers (`u128`, `i128`, `u256`, `i256`) for cryptography and very large ids. See [Big integers](#big-integers-u128-to-u256) below.

### Which one should I pick?

When in doubt, use these defaults and you will rarely be wrong:

- A counter, a size, a loop index, an id you do not do math on: **`u32`** (or `i32` if it can go negative).
- A millisecond timestamp, a like count that might grow huge, or a value that must never wrap: **`u64`** / **`i64`**.
- Anything with a decimal point (money, averages, percentages): **`f64`**.
- A true/false flag: **`bool`**.
- One raw byte, or an element of a byte buffer: **`u8`**.

Smaller types do not make your program meaningfully faster; they exist to match binary layouts and save memory in big arrays. Default to 32-bit unless a value is genuinely large or genuinely a byte.

## Integer overflow: it wraps, it does not throw

This is the single most important difference from everyday JavaScript. Integer math is **modular**: if a value goes past the top of its range, it silently wraps around to the bottom (two's complement). It never throws an error and never turns into a bigger type on its own.

```ts
let x: u8 = 255;
x = x + 1;   // x is now 0, not 256 (wrapped around)

let y: u8 = 0;
y = y - 1;   // y is now 255 (wrapped the other way)

let z: i32 = 2147483647; // the largest i32
z = z + 1;               // z is now -2147483648 (wrapped to the minimum)
```

The lesson: choose a type wide enough that your values cannot reach its edge. A counter that could exceed ~4.29 billion needs `u64`, not `u32`. Timestamps in milliseconds always use `u64`.

Floating-point (`f32` / `f64`) does not wrap; it follows the usual IEEE rules (very large values become `Infinity`, `0/0` is `NaN`).

## Casting between number types

Because types are explicit, the compiler will not silently mix them. To convert, cast. There are two equivalent spellings; use whichever reads better:

```ts
const big: u64 = 300;
const small: u8 = big as u8;   // "as" form
const small2 = u8(big);        // call the type like a function
```

Casting a wider integer into a narrower one **truncates**: it keeps only the low bits, so `u8(300)` is `44` (300 wraps modulo 256). Casting a float to an integer drops the fraction toward zero (`i32(3.9)` is `3`). None of these throw, so cast deliberately.

```ts
const f: f64 = 3.9;
const i = i32(f);   // 3 (fraction dropped)
const n = u8(300);  // 44 (truncated to 8 bits)
```

Integer division also truncates (it is not float division):

```ts
const half = 5 / 2;        // both operands are i32 -> result is 2, not 2.5
const real = 5.0 / 2.0;    // f64 division -> 2.5
```

## `bool`

`bool` is a real 1-bit type, not "any truthy value". Comparisons (`==`, `<`, `>=`) produce a `bool`, and `if`/`while` expect one. It stores as 0 or 1.

## Big integers: `u128` to `u256`

For values too large for 64 bits, toilscript provides `u128`, `i128`, `u256`, and `i256` as native global types (no import needed). They support the normal operators (`+`, `-`, `*`, `/`, `==`, `<`, `<<`, and so on) through operator overloading, plus static helpers like `u256.fromString(...)` and instance methods like `.toString()`, `.toBytes()`, and `.toUint8Array()`.

```ts
const a = u256.fromString('123456789012345678901234567890');
const b = a + u256.One;
const hex = b.toString(16);
```

These are mainly for cryptography and very large ids. Everyday counts and sizes should stay in `u32` / `u64`.

### `ToilUserId`: a 256-bit identity

The built-in auth system represents a logged-in user as a **`ToilUserId`**, a stable 256-bit value (four `u64` words) derived from their key, identifier, and your domain. It is a global type, like `crypto`. It is the right key to store per-user data on. Comparison is overloaded and O(1), and `.toHex()` gives you a 64-character string key.

```ts
const id: ToilUserId = AuthService.userId()!; // the current user's stable id
const key = id.toHex();                        // a convenient string key
```

Full reference (including the `==` null-check gotcha) is in [Extending auth](../auth/extending.md).

## Strings

Strings work as you expect: `'hello'`, template literals, `.length`, `.substring(...)`, `+` to concatenate. Under the hood a server string is **UTF-16** (the same 16-bit code units as JavaScript), so `.length` counts code units, not visible characters or bytes.

When you need the **bytes** of a string (to hash it, write it to a binary body, or send it over a stream), encode it explicitly. UTF-8 is almost always what you want on the wire:

```ts
const buf: ArrayBuffer = String.UTF8.encode('hello'); // UTF-8 bytes
const text: string = String.UTF8.decode(buf);         // back to a string
```

`String.UTF8.byteLength(s)` gives the encoded byte length. There is a matching `String.UTF16` namespace when you need raw UTF-16 bytes.

## Binary data: `Uint8Array`

Raw bytes are a `Uint8Array` (a fixed-length array of `u8`), exactly like the browser type. It is the standard currency for request bodies, hashes, crypto keys, and stream packets.

```ts
const bytes = new Uint8Array(32);
bytes[0] = 0xff;          // each element is a u8
const n: i32 = bytes.length;
```

You will also see `StaticArray<u8>` (a fixed-size, lower-overhead byte array) and `ArrayBuffer` (a raw buffer that `Uint8Array` and the encoders view). For most app code, `Uint8Array` is all you need.

## Arrays and collections

Typed arrays and the familiar collection types are available and must be typed:

```ts
const nums: i32[] = [1, 2, 3];        // Array<i32>
const names = new Array<string>();
const seen = new Map<string, u32>();
const tags = new Set<string>();
```

`Array`, `Map`, and `Set` behave like their JavaScript counterparts (`.push`, `.get`, `.has`, `.forEach`), but every element type is fixed at compile time. There is no mixed-type array.

## Objects: `@data` classes, not object literals

Server code has no free-form object type. A structured value is a **class**, and to send it between the browser and the server (or in and out of the database) you tag it `@data`. That makes the compiler generate a binary codec plus a matching client type. See [Data types](../backend/data.md).

```ts
@data
class Player {
    username: string = '';
    score: u64 = 0;
    constructor(username: string = '', score: u64 = 0) {
        this.username = username;
        this.score = score;
    }
}
```

## Key differences from normal TypeScript

| Thing | Normal TypeScript | Server (toilscript) |
| --- | --- | --- |
| Numbers | one `number` | explicit `u8` / `i32` / `u64` / `f64` / ... |
| `number` type | everywhere | avoid it; pick a fixed-width type |
| `any` | allowed | not allowed: everything is typed |
| Integer overflow | numbers just get bigger | wraps around silently |
| `/` on integers | `5 / 2` is `2.5` | `5 / 2` is `2` (truncates) |
| Mixing number types | implicit | explicit cast (`x as u8` / `u8(x)`) |
| npm packages | `import` anything | only toilscript's standard library and toiljs APIs |
| `undefined` | common | use `null` (a `T | null`), not `undefined` |
| Objects | `{ a: 1 }` literals | a `class` (usually `@data`) |
| Strings | UTF-16 | UTF-16 (same), encode to bytes for the wire |

A few rules worth stating plainly:

- **No `any`.** Every value has a concrete type. This is what makes the code compile to WASM at all.
- **No arbitrary npm.** Server code cannot pull in npm packages; it uses the toilscript standard library (the types on this page) plus the toiljs host APIs (database, crypto, email, and so on). This is the sandbox that keeps the edge safe.
- **No plain `number`.** If you write `number`, it resolves to `f64` (a float), which is almost never what you want for an id or a count. Always pick an explicit type.
- **Use `null`, not `undefined`,** for "no value": a nullable is written `T | null` and you narrow it with an `if (x != null)` check or a `!` assertion when you are sure.

## How server types cross to the browser

When a `@data` value or an RPC result travels to your frontend, the compiler maps each server type to a matching TypeScript type in the generated client. You do not write this mapping; it is generated. It matters because it tells you what your React code receives.

| Server type | Browser (generated TS) |
| --- | --- |
| `u8`, `u16`, `u32`, `i8`, `i16`, `i32`, `f32`, `f64` | `number` |
| `u64`, `i64`, `u128`, `i128`, `u256`, `i256` | `bigint` |
| `bool` | `boolean` |
| `string` | `string` |
| a `@data` class `T` | the generated class `T` |
| `T[]` | `T[]` |

The important row is the 64-bit-and-larger integers: they become `bigint` on the client and travel as decimal strings on the JSON wire, so they stay **exact at any size** (they never lose precision the way a giant JavaScript `number` would). See [RPC](../backend/rpc.md) for the generated client.

## Related

- [Data types (`@data`)](../backend/data.md): defining structs that cross the wire and the database.
- [RPC and the generated client](../backend/rpc.md): how server types map to browser types.
- [Extending auth](../auth/extending.md): the `ToilUserId` 256-bit identity in full.
- [The database (ToilDB)](../database/README.md): the collections your typed keys and values live in.
- [Decorators](./decorators.md): the decorators referenced throughout this page.
