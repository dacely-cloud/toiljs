// Static editor declarations for
// the toiljs server-runtime globals (Cookie, Cookies, SecureCookies, the
// cookie enums): @global in the runtime, used with no import. These alias the
// real runtime types so a global-built Cookie is exactly what Response.setCookie
// / SecureCookies.seal expect. The toilscript compiler registers them itself.
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
declare const Time: typeof import('toiljs/server/runtime/time').Time;
// Email, rate-limit, 2FA, and auth globals (server/globals/*), hand-declared
// because their AssemblyScript source can't be type-aliased from tsc.
declare enum EmailStatus { Sent, Disabled, Budget, RecipientCapped, Deduped, TryLater, BadRecipient, ProviderError }
declare namespace EmailService { function send(to: string, subject: string, body: string, purpose?: string, html?: string): EmailStatus; function sendDetached(to: string, subject: string, body: string, purpose?: string, html?: string): EmailStatus; }
declare class RenderedEmail { subject: string; body: string; html: string; constructor(subject: string, body: string, html: string); }
declare class EmailTemplate { constructor(subject: string, body: string, html?: string); render(vars: Map<string, string>): RenderedEmail; send(to: string, vars: Map<string, string>, purpose?: string): EmailStatus; }
declare namespace RateLimitService { function guard(routeId: i32, strategy: i32, limit: i32, window: i32): import('toiljs/server/runtime/response').Response | null; function guardKeyed(routeId: i32, strategy: i32, limit: i32, window: i32, key: string): import('toiljs/server/runtime/response').Response | null; }
declare namespace Environment { function get(key: string): string | null; function getSecure(key: string): string | null; }
declare class TwoFactorIssue { code: string; token: string; constructor(code: string, token: string); }
declare class TwoFactorChallenge { token: string; status: EmailStatus; constructor(token: string, status: EmailStatus); }
declare namespace TwoFactor { const DEFAULT_TTL_SECS: u64; const DEFAULT_DIGITS: i32; function setSecret(secret: Uint8Array): void; function issue(recipient: string, purpose: string, ttlSecs?: u64, digits?: i32): TwoFactorIssue; function send(recipient: string, purpose: string, ttlSecs?: u64, digits?: i32): TwoFactorChallenge; function verify(token: string, recipient: string, code: string): bool; }
declare namespace AuthService { function deleteUser(id: ToilUserId, realm?: string): bool; function indexUsers(limit?: i32, cursor?: Uint8Array | null): Uint8Array | null; function onRegistered(handler: (id: ToilUserId, username: string, email: string) => void): void; const SESSION_COOKIE: string; const USER_COOKIE: string; const LOGIN_CONTEXT: string; const PUBLIC_KEY_LEN: i32; const SIGNATURE_LEN: i32; const DEFAULT_SESSION_TTL_SECS: u64; function setSecret(secret: Uint8Array): void; function hasSession(): bool; function getSessionBytes(): Uint8Array | null; function getUser(): __ToilAuthUser | null; function userId(): ToilUserId | null; function enable(): void; function mintSession(userData: Uint8Array, ttlSecs?: u64, generation?: u64): Cookie; function clearSession(): Cookie; function revokeSession(): void; function revokeUserSessions(userData: Uint8Array): void; function userCookie(userData: Uint8Array, ttlSecs?: u64): Cookie; function clearUserCookie(): Cookie; function buildLoginMessage(sub: string, aud: string, cid: Uint8Array, nonce: Uint8Array, iat: u64, exp: u64, ciphertext: Uint8Array, memKiB: u32, iterations: u32, parallelism: u32, serverKemKeyId: Uint8Array): Uint8Array; function verifyLogin(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): bool; const KEM_CIPHERTEXT_LEN: i32; const KEM_SECRET_KEY_LEN: i32; const KEM_PUBLIC_KEY_LEN: i32; const SHARED_SECRET_LEN: i32; const OPRF_ELEMENT_LEN: i32; const OPRF_SEED_LEN: i32; const SESSION_KEY_LABEL: string; const SERVER_CONFIRM_LABEL: string; function setOprfSeed(seed: Uint8Array): void; function setServerKemSecretKey(secretKey: Uint8Array): void; function setServerKemPublicKey(publicKey: Uint8Array): void; function serverKemKeyId(): Uint8Array; function oprfEvaluate(username: string, blinded: Uint8Array): Uint8Array; function mlkemDecapsulate(ciphertext: Uint8Array): Uint8Array; function sha256(data: Uint8Array): Uint8Array; function deriveSessionKey(sharedSecret: Uint8Array, transcriptHash: Uint8Array): Uint8Array; function serverConfirmTag(sessionKey: Uint8Array, transcriptHash: Uint8Array): Uint8Array; const REGISTER_CONTEXT: string; function buildRegisterMessage(username: string, publicKey: Uint8Array): Uint8Array; function verifyRegister(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): bool; }
interface __ToilAuthUser { toilUserId: Uint8Array; username: string; }
declare class ToilUserId { w0: u64; w1: u64; w2: u64; w3: u64; constructor(w0?: u64, w1?: u64, w2?: u64, w3?: u64); static derive(mldsaPublicKey: Uint8Array, identifier: string, domain: string): ToilUserId; static fromBytes(b: Uint8Array): ToilUserId; toBytes(): Uint8Array; toHex(): string; isZero(): bool; equals(other: ToilUserId): bool; }
declare function __toilEncodeAuthUser(toilUserId: Uint8Array, username: string): Uint8Array;
