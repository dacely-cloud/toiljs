import { Server } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';

import { AppHandler } from './core/AppHandler';

// As you add surface modules (@rest routes, @service/@remote RPC), import them here
// so a direct `toilscript` run builds the same server `toiljs build` does, e.g.:
//   import './routes/Players';

// Wire your handler here.
Server.handler = () => new AppHandler();

// Required: re-export the WASM entry points and the abort hook.
export * from 'toiljs/server/runtime/exports';
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
