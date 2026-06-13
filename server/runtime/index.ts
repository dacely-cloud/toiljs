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

// Wall-clock (`Time.nowMillis()` / `Time.nowSeconds()`), backed by the host
// `Date.now()` binding. Ambient global (`@global`), also re-exported here.
export { Time } from './time';

// Edge SSR (`render` entrypoint): the render router + the typed slot-values
// API a route's `render(req)` fills. See `./exports/render`.
export { Ssr, SsrRegistry, RenderFn } from './ssr/Ssr';
export { SlotValues, SlotValue, HtmlBuilder } from './ssr/slots';

// HTTP layer (`@rest` / `@route`).
export { Rest, RestRegistry, RouteFn } from './rest/Rest';
export { RouteContext } from './rest/RouteContext';
export { matchRoute } from './rest/match';
export { RestHandler } from './rest/RestHandler';

// Cookies (`Cookie` / `Cookies` / `SecureCookies`). These are also ambient
// globals (`@global`), so a handler can use them with no import; the re-export
// keeps them importable and pulls the modules into every build.
export { Cookie, SameSite, CookieEncoding, CookiePrefix, CookieValidation } from './http/cookie';
export { Cookies, CookieMap } from './http/cookies';
export { SecureCookies } from './http/securecookies';
export { base64UrlEncode, base64UrlDecode } from './http/base64';
