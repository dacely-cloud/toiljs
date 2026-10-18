# Native staging checks

The native repository ships `toil-native-staging`, a loopback HTTP host for a
compiled request artifact. It uses the production Wasm validator, metered pool
and reset logic, host imports, request/response parser, and persistent ToilDB.
It requires provisioned persistent storage and fails startup if it is unavailable.

An operator provisions the host with your compiled artifact and a dedicated
staging database. The startup report identifies the loopback URL, PID, gas
budget, DB deadlines, and binary capabilities. Keep its state with its database
when restarting. Restart the host after rebuilding the artifact.

The default request gas budget is one billion units, host-call cap is 1024,
and DB tier is L3 in a standalone cell. Query/Action limits and default DB wait
deadlines use native defaults. `TOIL_STAGE_QUERY_DEADLINE_MS` and
`TOIL_STAGE_ACTION_DEADLINE_MS` override wait deadlines for testing; zero forces
an immediate wait timeout. HTTP reads and writes have five-second socket
timeouts. The host handles one request per connection and closes it afterward.
It runs the request artifact's derives, but has no resident cold scheduler,
static frontend, TLS, DPDK ingress, multi-cell owner routing, or production plan
selection. Use the actual target deployment for those checks.

Native acceptance tests exercise the compiled public SDK over real HTTP.
They prove gas exhaustion and recovery, unique-field conflicts, configured DB
wait deadlines, status-bearing JSON responses, and decoded UTF-8 query values.
The test creates isolated staging databases, child hosts, and local key files and cleans
them up. Its checked-in Wasm has source and rebuild instructions under
`tests/fixtures/native-staging`.

A failed request can leave earlier database writes committed. Gas exhaustion
and DB timeouts do not provide rollback. Check idempotent outcomes when retrying;
use [atomic partitioned documents](../database/atomic.md) for a supported
all-or-nothing record batch.

## Checking host compatibility

Updated native binaries support this read-only command, which exits before
reading server config or initializing DPDK:

```sh
target/debug/toil --print-capabilities
```

The report includes the binary SHA-256, optional `TOIL_BUILD_COMMIT` captured
at build time, accepted daemon catalog versions, surface/catalog ABI versions,
metering feature, and exact host-import allowlist. `toil-native-staging` exposes
the same command. Collect reports for the binaries actually installed on the
edge hosts; a local source build cannot establish the deployed fleet's versions.
Older binaries may lack this command, so inventory those using their release
records and running executable hashes. New SDK imports require matching native
support even when the daemon catalog version is accepted.
