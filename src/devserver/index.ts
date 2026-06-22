/**
 * Public barrel for the toiljs WASM dev server. The folder is organized into:
 *
 *   - `server.ts`  the uWebSockets.js front + `startDevServer` entrypoint
 *   - `runtime/`   the wasm module loader, host import surface, and crypto shims
 *   - `db/`        the in-process ToilDB emulation (the {@link DevDatabase} class)
 *   - `http/`      the envelope codec, response cache, and Vite proxy
 *   - `config/`    the dotenv loader, `Environment.get` source, and rate limiter
 *   - `email/`     the dev / self-host email pipeline
 *
 * The production edge backs the SAME wasm ABI (envelope layout, `handle(ofs,
 * len) -> i64`, host import surface, trap isolation), so a server that runs here
 * runs there. See `server.ts` for the request flow.
 */

export { startDevServer } from './server.js';
export type { DevServerOptions, RunningDevServer } from './server.js';

export {
    METHOD_CODES,
    encodeRequestEnvelope,
    decodeResponseEnvelope,
    unpackHandleResult,
} from './http/envelope.js';
export type { EnvelopeRequest, EnvelopeResponse } from './http/envelope.js';
export { WasmServerModule, WasmAbortError, UNHANDLED_HEADER } from './runtime/module.js';
export type { WasmDispatchResult } from './runtime/module.js';
export { buildHostImports, freshDispatchState } from './runtime/host.js';
export type { DispatchState, MemoryRef } from './runtime/host.js';
export type { ViteTarget } from './http/proxy.js';

// Dev DAEMON (L4) emulation (RECONCILIATION Part 2/5; doc 08 section 5).
export { DaemonHost, daemonEmulationEnabled } from './daemon/index.js';
export { parseDaemonCatalog } from './daemon/catalog.js';
export type { DaemonCatalog, ScheduledTask, CronMasks } from './daemon/catalog.js';
export { buildDaemonImports, freshDaemonState } from './daemon/host.js';
export type { DaemonState, DaemonRuntime, ResolvedDaemonConfig } from './daemon/host.js';
export { cronMatches, cronNeverFires, nextCronFireMs } from './daemon/cron.js';
export { parseSurface } from './wasm/surface.js';
export type { Surface, SurfaceFlags } from './wasm/surface.js';
export { customSection } from './wasm/sections.js';
export { DevMemoryStore, devMemoryStore } from './mstore/store.js';
