import { Server } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';

import { AppHandler } from './core/AppHandler';

// Surface modules: @rest routes and @service/@remote RPC. `toiljs build` discovers every
// decorated file under server/ on its own; importing them here keeps a direct `toilscript`
// run (which only sees the toilconfig entries) building the exact same server.
import './routes/Players';
import './routes/Leaderboard';
import './services/Stats';
import './services/remotes';

// DO NOT TOUCH THIS.
Server.handler = () => {
    // ONLY CHANGE THE HANDLER CLASS NAME.
    // DO NOT ADD CUSTOM LOGIC HERE.

    return new AppHandler();
};

// VERY IMPORTANT
export * from 'toiljs/server/runtime/exports';

// VERY IMPORTANT
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
