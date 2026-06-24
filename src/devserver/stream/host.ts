/**
 * Host-import surface for the dev STREAM (hot, L2/L3) box, mirroring the production edge's stream box
 * (`toil-backend` `src/wasm/stream`). A `@stream` box is a HOT artifact: it imports the same request
 * `env.*` runtime surface (so the ToilScript runtime + `@data`/crypto/env/`Date.now` code runs
 * unchanged) and drives its lifecycle through the `stream_dispatch` export + the ingress/egress ring
 * bridge ({@link ../index.js}), NOT through `handle`.
 *
 * The `stream.*` namespace (`stream.send` / `@channel`) is DEFERRED: the raw `@message` ring bridge -
 * the only stream feature wired so far - needs NO host imports (the guest reads/writes the rings in
 * its own linear memory). A box that does not use `stream.*` instantiates against `env.*` alone.
 */

import { buildDatabaseImports, type DbDevState, freshDbState } from '../db/index.js';
import { buildCryptoImports, type CryptoState, freshCryptoState } from '../runtime/crypto.js';
import { buildEnvImports, type MemoryRef } from '../runtime/host.js';

/** Per-stream-box host scratch (DB + crypto), analogous to the daemon's `DaemonState`. Each resident
 *  connection box carries its own, so two connections never share `@data` transaction scratch. */
export interface StreamBoxState {
    crypto: CryptoState;
    db: DbDevState;
}

export function freshStreamBoxState(): StreamBoxState {
    return { crypto: freshCryptoState(), db: freshDbState() };
}

/**
 * The full `env` import object for a dev stream box: the request-surface `env.*` runtime (built by
 * {@link buildEnvImports}) plus the crypto and `@data` namespaces. The response/stream `env.*`
 * functions a box must not have (`set_status`/`respond_file`/...) are excluded by `buildEnvImports`
 * itself, exactly as for the daemon cold box.
 */
export function buildStreamImports(ref: MemoryRef, state: StreamBoxState): WebAssembly.Imports {
    return {
        env: {
            ...buildEnvImports(ref, state),
            ...buildCryptoImports(ref, state.crypto),
            ...buildDatabaseImports(ref, state.db),
        },
    };
}
