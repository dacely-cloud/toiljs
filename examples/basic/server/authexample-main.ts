import { Server } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import { Request, Response, Rest, ToilHandler } from 'toiljs/server/runtime';
import './routes/Auth';
class H extends ToilHandler { public handle(req: Request): Response { const h = Rest.dispatch(req); return h != null ? h : Response.notFound(); } }
Server.handler = () => { return new H(); };
export * from 'toiljs/server/runtime/exports';
export function abort(m: string, f: string, l: u32, c: u32): void { revertOnError(m, f, l, c); }
