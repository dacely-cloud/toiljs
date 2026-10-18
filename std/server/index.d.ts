// Generated from server/runtime by scripts/gen-server-types.mjs.
/// <reference path="../../server/globals.d.ts" />
/**
 * Public surface of the toiljs server runtime. The user does
 *
 * ```ts
 * import { Server, ToilHandler, Response } from './runtime';
 * ```
 *
 * and then assigns `Server.handler = () => new MyHandler()` in their
 * `main.ts`. The wasm `handle(i32, i32) -> i64` export comes from
 * `./exports`, which the user re-exports with `export * from
 * './runtime/exports'`. The `abort` runtime hook comes from
 * `./abort/abort`, which the user re-exports as a top-level `abort`
 * function in their `main.ts`.
 */
export { Header, Method, Request } from './request';
export { Response, TOIL_UNHANDLED_HEADER } from './response';
export { ToilHandler } from './handlers/ToilHandler';
export { Server, ServerEnvironment } from './env/Server';
export { Time } from './time';
export { Ssr, SsrRegistry, RenderFn } from './ssr/Ssr';
export { SlotValues, SlotValue, HtmlBuilder } from './ssr/slots';
export { Rest, RestRegistry, RouteFn } from './rest/Rest';
export { Rpc, RpcRegistry, RpcFn, RPC_PATH, RPC_HEADER } from './rpc/Rpc';
export { RouteContext } from './rest/RouteContext';
export { matchRoute } from './rest/match';
export { RestHandler } from './rest/RestHandler';
export { Cookie, SameSite, CookieEncoding, CookiePrefix, CookieValidation } from './http/cookie';
export { Cookies, CookieMap } from './http/cookies';
export { SecureCookies } from './http/securecookies';
export { base64UrlEncode, base64UrlDecode } from './http/base64';
export { Blobs, BlobStorage, BlobUpload, BlobField } from './files/blobs';
export { Images, ImageResult, ImageFormat, ImageError } from './files/images';
