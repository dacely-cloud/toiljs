import { Server } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import { SpinHandler } from './SpinHandler';

Server.handler = () => {
    return new SpinHandler();
};

export * from 'toiljs/server/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
