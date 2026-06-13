/**
 * Editor-only ambient declarations for the toiljs server-runtime globals.
 *
 * `Cookie`, `Cookies`, `SecureCookies`, and the `SameSite` / `CookieEncoding` /
 * `CookiePrefix` enums are `@global` in the toiljs server runtime, so a handler
 * uses them with no import (exactly like `crypto`). These ALIAS the real runtime
 * types (the same trick the IO globals use in `toil-env.d.ts`), so a globally-
 * built `Cookie` is the exact type the runtime APIs (`Response.setCookie`,
 * `SecureCookies.seal`, ...) expect. Redeclaring them as standalone classes
 * makes a second, nominally-incompatible `Cookie` (private fields) that fails
 * assignment. The toilscript compiler registers the globals itself; this file
 * is editor-only, auto-included by the server tsconfig and ignored by the
 * compiler.
 *
 * `toiljs create` scaffolds this file.
 */

declare const SameSite: typeof import('toiljs/server/runtime/http/cookie').SameSite;
type SameSite = import('toiljs/server/runtime/http/cookie').SameSite;
declare const CookieEncoding: typeof import('toiljs/server/runtime/http/cookie').CookieEncoding;
type CookieEncoding = import('toiljs/server/runtime/http/cookie').CookieEncoding;
declare const CookiePrefix: typeof import('toiljs/server/runtime/http/cookie').CookiePrefix;
type CookiePrefix = import('toiljs/server/runtime/http/cookie').CookiePrefix;
declare const CookieValidation: typeof import('toiljs/server/runtime/http/cookie').CookieValidation;
type CookieValidation = import('toiljs/server/runtime/http/cookie').CookieValidation;
declare const Cookie: typeof import('toiljs/server/runtime/http/cookie').Cookie;
type Cookie = import('toiljs/server/runtime/http/cookie').Cookie;
declare const CookieMap: typeof import('toiljs/server/runtime/http/cookies').CookieMap;
type CookieMap = import('toiljs/server/runtime/http/cookies').CookieMap;
declare const Cookies: typeof import('toiljs/server/runtime/http/cookies').Cookies;
type Cookies = import('toiljs/server/runtime/http/cookies').Cookies;
declare const SecureCookies: typeof import('toiljs/server/runtime/http/securecookies').SecureCookies;
type SecureCookies = import('toiljs/server/runtime/http/securecookies').SecureCookies;
