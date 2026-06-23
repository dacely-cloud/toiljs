# Time

`Time` is the guest's wall-clock. It is the toiljs-blessed way to read the
current time, backed by the host's `Date.now()` binding (`env.Date.now`). Both
the edge and the dev server provide that binding, so time behaves identically in
`toiljs dev` and in production.

It is available as an ambient global (`@global`, no import) and is also exported
from `toiljs/server/runtime`.

```ts
import { Time } from 'toiljs/server/runtime'; // optional; Time is also a global

const ms = Time.nowMillis();   // u64 milliseconds since the Unix epoch
const s  = Time.nowSeconds();  // u64 whole seconds since the Unix epoch
```

## API

| Member | Signature | Description |
| --- | --- | --- |
| `Time.nowMillis()` | `static nowMillis(): u64` | Milliseconds since the Unix epoch (the raw host `Date.now()` value). |
| `Time.nowSeconds()` | `static nowSeconds(): u64` | Whole seconds since the epoch (`nowMillis() / 1000`). The unit used by sessions and login challenges. |

## Semantics

`Time` is **wall-clock, not monotonic**, exactly like browser `Date.now()`. It
tracks the system clock and can step backward across an NTP correction.

- Use it to stamp and compare absolute instants: session `iat`/`exp`, login
  challenge expiry, cache ages.
- Do **not** use it to measure elapsed time or as a high-resolution timer; a
  backward step would produce a negative or zero interval.

## Relationship to `Date.now()`

ToilScript's `Date.now()` lowers to the same `env.Date.now` host import, so you
*can* call it directly. Prefer `Time`: it makes the host boundary (and the
single millisecond unit) explicit and easy to find, and it gives you
`nowSeconds()` without an open-coded `/ 1000` cast at every call site.

`AuthService` uses `Time.nowSeconds()` internally for session `iat`/`exp`, so
session timing and any timing you do in a handler share one clock.
