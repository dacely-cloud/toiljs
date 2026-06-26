// The L2/L3 STREAM surface entry.
//
// This is a SECOND entry point of the project, distinct from `main.ts` (the L1 request surface). It
// compiles into its OWN artifact - `build/server/release-stream.wasm` - which the Toil edge loads as a
// RESIDENT per-connection box on the L2/L3 stream tier, and which the dev server serves over a WebSocket.
//
// Importing the `@stream` modules here pulls their compiler-generated `stream_dispatch` export (the
// connect/message/close/disconnect lifecycle entry) into this artifact. Add a stream as you grow:
//   import './streams/Echo';

import { revertOnError } from 'toiljs/server/runtime/abort/abort';

import './streams/Echo';

// Required: re-export the WASM entry points (the linear memory + the runtime hooks the host binds) and
// the abort hook, exactly like main.ts.
export * from 'toiljs/server/runtime/exports';
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
