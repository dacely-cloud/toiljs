/**
 * Edge-SSR example entry. Registers the `/hello` render (side-effect import),
 * sets a no-op HTTP handler (so the `handle` export is well-formed), and
 * surfaces the wasm exports — including `render(i32, i32) -> i64`.
 */
import { Server, ToilHandler } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import './SsrGreetingRender';

Server.handler = () => {
    return new ToilHandler();
};

export * from 'toiljs/server/runtime/exports';

export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
