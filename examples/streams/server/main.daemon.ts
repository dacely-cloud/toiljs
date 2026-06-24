// The L4 DAEMON surface entry.
//
// The THIRD entry point of the project, distinct from `main.ts` (L1 request) and
// `main.stream.ts` (L2/L3 stream). It compiles into its OWN artifact -
// `build/server/release-cold.wasm` - which the Toil edge loads as the single
// leader-elected daemon box per domain (the global coordination tier).
//
// Importing the `@daemon` modules here pulls their compiler-generated `daemon_start`
// / `scheduled_tick` exports into this artifact. Add a daemon as you grow:
//   import './daemon/Jobs';

import { revertOnError } from 'toiljs/server/runtime/abort/abort';

import './daemon/Jobs';

// The abort hook (the daemon box reports a trap through it). NOTE: unlike main.ts /
// main.stream.ts, the daemon entry does NOT re-export the request runtime - a cold
// artifact exposes daemon_start/scheduled_tick, not the request `handle`.
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
