/**
 * The framework's built-in authenticated-user shape for `server.auth` (the
 * zero-config `/auth/*` PQ-login controller). Shipped as a SOURCE file that the
 * `server.auth` build APPENDS to the toilscript entry set, so its `@user`
 * decorator weaves exactly as a hand-written one would (a file under
 * `server/globals` is a toilscript `lib` source, where decorators do NOT weave;
 * this file is compiled as a user ENTRY instead).
 *
 * `@user` declares the authenticated user's shape: it becomes a binary codec
 * (like `@data`) AND registers the type of `AuthService.getUser()` everywhere,
 * server and generated client, with NO type argument. There is exactly ONE
 * `@user` per program — the built-in owns it. An app that needs a different user
 * shape hand-writes its own auth controller (and its own `@user`) instead of
 * opting into `server.auth`.
 *
 * The class is named `SessionUser`, NOT `AuthUser`: the toilscript `@user`
 * transform injects a `@global class AuthUser extends <thisClass>` binding for
 * `AuthService.getUser()`, so naming this class `AuthUser` would produce
 * `class AuthUser extends AuthUser` (a duplicate-identifier / self-extension
 * compile error).
 */

// @user: the authenticated-user shape. Exactly one per program; the built-in
// owns it. `toilUserId` is FIRST so `AuthService.userId()` can recover the
// stable id straight from the session codec (see server/globals/auth.ts).
@user
class SessionUser {
    toilUserId: Uint8Array = new Uint8Array(0);
    username: string = '';
}

/**
 * Encode the built-in `@user` session payload for a just-authenticated user.
 * Derives the stable, tenant-scoped {@link ToilUserId} from the user's ML-DSA
 * login public key + their username + the request's tenant `domain`, so the same
 * user on the same site always maps to the same id. Exported as a FUNCTION (not
 * the class, which would warn AS235) so the login controller mints a session via
 * the same generated `@user` codec.
 */
export function encodeSessionUser(
    mldsaPublicKey: Uint8Array,
    username: string,
    domain: string,
): Uint8Array {
    const u = new SessionUser();
    u.toilUserId = ToilUserId.derive(mldsaPublicKey, username, domain).toBytes();
    u.username = username;
    return u.encode();
}
