/**
 * The framework's built-in authenticated-user shape for `server.auth` (the zero-config `/auth/*` PQ-login
 * controller). Shipped as a SOURCE file the `server.auth` build APPENDS to the toilscript entry set in
 * BUILTIN mode (the app declares no `@user` of its own), so its `@user` decorator weaves as a user entry.
 *
 * The class is deliberately EMPTY. The build runs with `--authUser`, which injects the reserved
 * `toilUserId` + `username` identity fields (toilUserId FIRST, so `AuthService.userId()` reads it straight
 * from the session codec) and a shape-agnostic `__toilEncodeAuthUser(id, username)` global the controller
 * uses to mint a session. This keeps the wire layout identical whether the user is this built-in shape or an
 * app's own.
 *
 * EXTEND mode: an app that wants a richer authenticated user just declares its OWN `@user` (with extra
 * fields like `admin` or `tenant`). The build detects it, extends THAT class with the same reserved fields,
 * and does not append this file. Either way there is exactly one `@user` per program.
 *
 * Named `SessionUser`, NOT `AuthUser`: the toilscript `@user` transform injects a `@global class AuthUser
 * extends <thisClass>`, so naming this class `AuthUser` would self-extend (a compile error).
 */

// @user: the authenticated-user shape. The reserved `toilUserId` + `username` fields are INJECTED by the
// build (`--authUser`); do not declare them here.
@user
class SessionUser {}
