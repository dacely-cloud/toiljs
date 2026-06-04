import { Server } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import { HelloHandler } from './HelloHandler';

// DO NOT TOUCH THIS.
Server.handler = () => {
    // ONLY CHANGE THE HANDLER CLASS NAME.
    // DO NOT ADD CUSTOM LOGIC HERE.

    return new HelloHandler();
};

// VERY IMPORTANT
export * from 'toiljs/server/runtime/exports';


// VERY IMPORTANT
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
