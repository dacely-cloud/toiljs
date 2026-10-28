# Release audit: 2026-10-28

This review covers ToilJS 0.0.138, ToilScript 0.1.67, and toil-backend / internal ToilDB 0.1.1. The original report contained sixteen items. The implementations and their tests were reviewed together across all three repositories.

## Additional defects reproduced during release review

- **Interrupted account cleanup reopened erased epoch claims.** A crash after anonymizing a revision but before saving the cursor caused a retry to release that anonymous claim again. A regression counted 25 releases for 24 revisions before the fix. Cleanup now recognizes anonymous records and keeps those slots occupied. The review also added erasure of the legacy pending-enrollment replay counter and raised the per-slice budget reserve.
- **Contextual lowercase still used old Unicode properties.** `" AΣ"` incorrectly produced `" aσ"`; newly cased letters and runs of more than thirty case-ignorable characters exposed further failures. Context checks now use checksum-pinned Unicode 17 `Cased` / `Case_Ignorable` properties and the correct unbounded context rules. Deterministic regressions cover both directions and overlapping properties.
- **A collector gas trap allowed reentry into a partially modified heap.** A native metered fixture exhausted gas inside `__collect`, then successfully entered it again after refill. Collection now quarantines the instance until the artifact is reloaded. Ordinary task traps remain retryable on the resident box. The regression verifies refusal of collection, startup and init after failure.
- **The framework still permitted an older compiler.** Package dependencies, peers, starter output, doctor minimum and example lockfiles now require ToilScript 0.1.67.

## Original report disposition

| Item | Result and evidence |
| --- | --- |
| 1. Large integer decimal formatting | Native-limb division in base 10^19; 8,480 reference comparisons and native gas measurements. Maximum u128/u256 probes use 505,638 / 952,570 gas, down from 101,229,762 / 388,102,795. |
| 2. Missing lowercase mappings | All 1,488 Unicode 17 simple lowercase mappings checked; contextual sigma regressions added during audit. |
| 3. NFD composition data | Literal normalization forms select distinct helpers before emission. Tests check composition-table exclusion for decomposition-only modules and execute literal/dynamic forms against the official corpus. |
| 4. Resident daemon overhead | Cold builds use the minimal collector. Node/native hosts collect with an unwound stack before ticks/derives. A 520-tick Node test checks a memory plateau, persistent state and task traps; native tests check dispatch and collector failure. |
| 5. Deleted account factor data | Bounded resumable erasure covers historical epochs, current/legacy factor stores and replay counters. Tests compile real deletion handlers, old-schema bytes, interruption, retries and account recreation. Native unique release uses an observed-owner conditional delete. |
| 6. Auth/config documentation | App guidance no longer assumes repository-only proof tests; `authRoutes` is in the config reference. |
| 7. Gas measurement and schedule | [Native gas](./services/gas.md) documents the native measurement runner, opcode/import prices, separate budgets, settings, task failures and collector quarantine. |
| 8. Derive writes | Documentation now matches compiler/native permissions: Membership and SortedIndex mutation are unavailable in derives. |
| 9. Exact post limits | `RateLimit.TrailingWindow` uses tag 3 across compiler, framework and native host. Boundary/reference tests cover 10,000 decisions; native table-pressure tests retain active histories. |
| 10. Native result bytes | Gas guide records present/absent getMany framing and the zero result-byte cost of exists, separately from gas. |
| 11. Cells and host mode | Gas guide distinguishes asynchronous cross-cell operations from synchronous restrictions. Checked launcher source; no claim that a particular live deployment was inspected. |
| 12. Refused writes and owner batching | Gas guide records write admission before comparison and the absence of an owner-batch ABI or committed delivery date. |
| 13. Continuation polling | Gas guide records the native one-second idle wake constant, leadership gate and possible delays from running work. |
| 14. Fresh Scylla scans | Documents guide requires directory backfill even on a new empty Scylla keyspace; the in-memory engine maintains its directory directly. |
| 15. Auth route policy | Added `deleteAccount`; disabling enrollment allows proof-backed removal of existing email/TOTP factors while rejecting enrollment verification. Compiled route tests and real Chrome checks cover policy variants. |
| 16. Build cache | Sorted library listings and concrete per-tier miss diagnostics. Tests check invalidation reasons and unchanged compiled artifact timestamps. The report's untraced historical miss cannot be attributed conclusively. |

## Verification and limits

The compiler passes its full test suite, TypeScript config/import checks and targeted JavaScript lint. Unicode checks include 801,396 normalization comparisons, 20,019 category/property checks and the mapping/decimal comparisons above. The framework passes build, typecheck, lint, both example builds/checks, the full suite with normal and strict database limits, and browser auth checks. The release workflow repeats its repository checks before publishing where configured.

Native verification includes 926 passing library tests (12 ignored), the new collector exhaustion regression, and a compiling gas-meter example. The full ToilDB suite passed against an isolated Scylla instance: 483 passed, 2 ignored. Temporary Scylla resources were removed.

One earlier parallel native library run terminated with SIGSEGV without identifying a failing test. A serial run and subsequent parallel runs passed; the crash's cause remains unidentified. No production deployment, load test, or live Dacely host inspection was performed.

Deploy toil-backend 0.1.1 before using tag 3 or minimal-runtime cold artifacts from ToilJS 0.0.138. Reload a cold artifact after a collector trap; a gas refill does not repair partial collection. Previously committed task writes remain committed after a trap.
