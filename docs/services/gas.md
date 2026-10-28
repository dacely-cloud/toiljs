# Native gas and database accounting

These rules describe the native host source alongside toiljs. `toiljs dev` and
Node self-hosting execute WebAssembly without native gas instrumentation; their
database budget checks are separate (`TOIL_DEV_CHECK_DB_LIMITS=1`). Instruction
counts from another Wasm runner are useful comparisons but are not native gas.

## Measuring locally

Build toil-backend with `cargo build --release --features debug-gas-headers --bin toil`
and use that binary to serve the application. Successful HTTP responses expose
`Dacely-Gas-Used` and `Dacely-Gas-Remaining`; exhaustion returns 502. Ordinary
builds still enforce and account gas but omit these diagnostic headers. A
pure-compute probe exposing a zero-argument i32 function can also be measured with
`cargo run --example measure_wasm_gas -- file.wasm export_name 128000000`.
That runner prints startup and dispatch gas separately and supports `env.abort`;
use the HTTP path for applications requiring other host imports. A
programmatic runner can use `wasm::middlewares::{set_remaining_points,
get_remaining_points}` with the same native engine and bound host imports.
Instantiation and each dispatch must be measured separately. See native
`tests/gas_headers.rs` for a complete pooled-instance example.

## Schedule

Gas is a weighted cost model, **not one unit per instruction**. The authoritative
opcode schedule is `toil-backend/src/wasm/middlewares/gas_costs.rs`; host-import
prices are in `src/config.rs::metering`, and crypto has its own cost schedule.
Examples from that schedule:

| Work | Gas |
| --- | ---: |
| i32 constant | 1 |
| local get / set | 75 / 200 |
| i32 add / multiply / unsigned divide | 75 / 96 / 448 |
| direct call | 3,744 |
| branch / conditional branch | 750 |
| scalar memory load or store | 1,472 |
| `memory.copy` of N bytes | 384 + 32 × ceil(N / 16) |
| `memory.fill` of N bytes | 256 + 32 × ceil(N / 16) |
| `memory.grow` of P pages | 8,000 + 32,768 × P |
| common host call base | 6,400 |
| database resolve / keyed read / write base | 25,600 / 19,200 / 38,400 |
| database input value byte | 32 |
| database result byte copied by `data.take_result` | 16 |
| `server_log` with N UTF-8 bytes | 6,400 + N |

Database key/input bytes, result framing and additional imports also carry
charges; a high-level operation can call more than one import. For example,
compare-exchange charges expected and replacement bytes, and draining a result
is another host call. Invalid/refused work still pays the charges incurred
before rejection. Logging allows 32 messages per invocation and 4,096 UTF-8
bytes per message. Database operation/write/byte limits remain independent of gas.

## Budgets and lifecycle

The default free plan funds each HTTP dispatch with 128,000,000 gas. Pro's base is
256,000,000. Module instantiation/start has a separate 20,000,000 gas allowance,
including declared-memory precharge (32,768 per initial page); it does not spend
an HTTP invocation's 128M allowance. A fresh native instance pays startup again.

Each automatic derive invocation receives a fresh gas budget and fresh derive
DB limits. It does not use the request's remaining gas. Request diagnostic
headers are finalized before automatic derives, so they report the request
itself. Cold derives receive the cold box's tick gas budget for each invocation.
A manually entered derive context within a Job does not create another Wasm
invocation or another gas allowance.

Each scheduled task invocation gets its own `gas_scheduled` allowance. Exhaustion
traps that invocation. Writes already committed remain committed; there is no
transaction rollback. The scheduler records the failed fire, retains the
resident box and continues its static schedule. It does not immediately replay
the failed task. The next invocation gets a fresh budget. Minimal-runtime cold
artifacts collect temporary allocations with an unwound guest stack before each
tick and derive; collection shares that invocation's budget and preserves roots.
If collection itself traps, the native host refuses further guest calls on that
box because interrupted mark/sweep can leave partial pointer updates. Reload the
artifact to replace the instance; increasing the budget alone cannot repair it.

`gas_hint` in the daemon catalog is currently metadata: the compiler emits zero
and the scheduler does not use it to override a task's plan budget.

## Operator settings

Native tenant reserved settings include `TOIL_PLAN`, `TOIL_LIMIT_GAS` (all dispatch
kinds), `TOIL_LIMIT_GAS_HTTP`, `TOIL_LIMIT_GAS_SCHEDULED`, and
`TOIL_LIMIT_GAS_RPC`. RPC currently uses the HTTP dispatch budget; the separate
RPC plan field does not create independent enforcement. Stream settings include
`TOIL_LIMIT_GAS_STREAM`, `TOIL_LIMIT_GAS_STREAM_CONNECT`,
`TOIL_LIMIT_GAS_STREAM_MESSAGE`, and `TOIL_LIMIT_GAS_CHANNEL_PUBLISH`.

Related independent limits include `TOIL_LIMIT_GAS_PER_DAY`,
`TOIL_LIMIT_MAX_EXTERN_CALLS`, `TOIL_LIMIT_MAX_MEM_PAGES`,
`TOIL_LIMIT_DAEMON_MEM_PAGES`, `TOIL_LIMIT_MAX_SCHEDULED_TASKS`,
`TOIL_LIMIT_DB_TIER`, `TOIL_LIMIT_MAX_BODY_BYTES`, and sustained/request/throughput
limits. A zero gas override does not make gas unlimited. Reserved native settings
are operator-controlled and bounded by host ceilings. The development daemon's
`server.daemon.gasTick` is configuration metadata, not a native gas meter.

## Native database details

`getMany` charges one DB operation, actual value bytes plus **9 framing bytes per
present item**, one byte per absent item, and a four-byte count per batch. The
nine bytes are the presence flag, schema version and value length. `exists`
charges an operation but no result bytes. These rules match the development
host. Gas for copying results is an additional, independent charge.

A refused compare-exchange still counts as a write and a DB operation: admission
happens before comparison. The default Action budget is 64 operations / 32 writes.
There is no owner-read batch ABI in this version: `getMany` is not a batch of
`getCurrentSnapshot` calls. Use bounded individual owner reads for conditional
protocols; there is no committed delivery date for an owner-batch API.

On the asynchronous native host, an Action can read and conditionally write keys
owned by different cells, with the normal per-call operation, depth and deadline
limits. Each key's compare-exchange is atomic individually; several keys are not
one transaction. The synchronous host refuses remote-owner conditional work.
The supplied native `start.sh` selects `--inline-async`. That launcher is source
evidence of the configured mode, not proof of a particular live Dacely deployment;
operators should inspect the actual process arguments before depending on it.

The native cold scheduler wakes at most one second apart while idle and picks up
durable derive continuations on those wakes, provided it still holds leadership.
Long-running work can delay a wake. The interval is currently a scheduler constant,
not a per-application configuration option; development also polls once a second.

With native Scylla storage, **even a fresh keyspace** needs a successful
`ScyllaEngine.backfill_record_directory()` before `Documents.scan` can run: the
readiness marker is only written by that migration (an empty backfill writes it
too). Upgrade all writers first. The native in-memory engine maintains its
directory directly and needs no backfill. Scans still require a complete local
copy, as described in [Documents](../database/documents.md#background-collection-scans).
