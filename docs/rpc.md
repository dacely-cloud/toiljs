# RPC and the generated client

The server build with `--rpcModule shared/server.ts` scans your decorated
surface (`@data`, `@user`, `@service`/`@remote`, `@rest`) and emits one
TypeScript module: a typed `Server` proxy, the `@data` codec classes, the REST
fetch client, and the `getUser()` accessor. The client imports that file and
calls the server with full type-safety and editor autocomplete. The file is
regenerated on every server build, so it never drifts from the server.

```sh
toilscript --target release --rpcModule shared/server.ts
```

## `@service` and `@remote`

A `@service` class exposes its `@remote` methods as callable RPC. A top-level
`@remote` function is exposed directly.

```ts
@service
class Stats {
  @remote
  public playerCount(): i32 { return store.size; }
}

@remote
function ping(n: i32): i32 { return n + 1; }
```

The generated client surfaces these on the global `Server` proxy. A service is
keyed by its class name with the first letter lowercased (`Stats` → `stats`):

```ts
await Server.stats.playerCount(); // Promise<number>
await Server.ping(42);            // Promise<number>
```

Arguments and return values are `@data`-typed; scalars map to TS as below.

## The generated `Server` surface

`shared/server.ts` declares a global `Server` whose shape is, schematically:

```ts
declare global {
  const Server: {
    // top-level @remote functions
    ping(n: number): Promise<number>;

    // @service classes (keyed by lowercased name)
    readonly stats: {
      playerCount(): Promise<number>;
    };

    // @rest controllers, under REST
    readonly REST: {
      readonly players: {
        get(args: { params: { id: string | number | bigint }; query?: …; headers?: … }): Promise<Response>;
        create(args: { body: NewPlayer; query?: …; headers?: … }): Promise<Player>;
      };
    };
  };
}
```

### Type mapping (ToilScript → TypeScript)

| ToilScript | TypeScript |
| --- | --- |
| `u8`,`u16`,`u32`,`i8`,`i16`,`i32`,`f32`,`f64` | `number` |
| `u64`,`i64`,`u128`,`i128`,`u256`,`i256` | `bigint` |
| `bool` | `boolean` |
| `string` | `string` |
| a `@data` class `T` | `T` (the emitted class) |
| `T[]` | `T[]` |

64-bit-and-larger integers are `bigint` on the client and travel as decimal
strings on the JSON wire, so they are exact at any magnitude.

### Emitted `@data` classes

Each `@data` (and `@user`) class becomes an exported TS class with the fields, a
defaulted constructor, and the matching codec:

```ts
export class Player {
  constructor(public username = '', public admin = false, public score = 0n) {}
  encodeInto(w: DataWriter): void { /* … */ }
  encode(): Uint8Array { /* dataId prefix + fields */ }
  static decodeFrom(r: DataReader): Player { /* … */ }
  static decode(buf: Uint8Array): Player { /* … */ }
  static dataId(): number { /* FNV-1a of "Player" */ }
  static fromJSONValue(v: any): Player { /* revive, 64-bit from strings */ }
  toJSONValue(): any { /* 64-bit as decimal strings */ }
}
```

The codec is byte-compatible with the server's `@data` codec, so binary bodies
round-trip exactly between client and wasm.

## The REST fetch client

Every `@rest` route also gets a typed fetch wrapper under `Server.REST.<key>`,
keyed by the controller name lowercased. The call argument is an object:

```ts
Server.REST.players.create({
  body: new NewPlayer('alice'),     // present iff the route takes a body
  // params: { id: 7 },             // present iff the path has :params
  query: { ref: 'home' },           // optional
  headers: { 'x-trace': traceId },  // optional
});
```

- If the route has no params and no body, the whole argument is optional
  (`args?`).
- The wrapper builds the URL (substituting `:params`, appending `query`),
  `fetch`es with `credentials` as configured, throws on a non-2xx status, and
  decodes the response into the route's return type.
- A route declared to return `Response` resolves to the raw `fetch` `Response`,
  so you can stream or inspect headers yourself.

```ts
const player = await Server.REST.players.create({ body: new NewPlayer('alice') });
//    ^? Player
```

## `getUser()`

When the server declares a `@user` class, the generated module also exports a
typed, no-argument `getUser()` that reads the readable companion cookie and
decodes it with the generated codec:

```ts
import { getUser } from './shared/server';

const user = getUser(); // Account | null, fully typed
```

This is **display-only**: the server re-verifies the signed session on every
`@auth` request. See [Auth](./auth.md) for the full picture.

## Notes

- `shared/server.ts` is generated; never edit it by hand. Re-run the server
  build (or `toiljs dev`, which does it on save) to refresh it.
- The `Server` proxy is declared as an ambient global on the client; the runtime
  implementation is provided by toiljs. The REST client and `getUser` are real
  exported values in the generated module.
