import { Response, RouteContext } from 'toiljs/server/runtime';
import { DataReader, DataWriter } from 'data';

/**
 * Session demo: the `@user` / `@auth` / typed `AuthService.getUser()` surface.
 *
 * `@user` declares the authenticated user's shape; it becomes a binary codec
 * (like `@data`) AND registers the type of `AuthService.getUser()` everywhere,
 * server and generated client, with NO type argument.
 *
 * `@auth` on a route (or a whole `@rest` class) makes the generated dispatcher
 * verify a valid signed session BEFORE the handler runs (401 otherwise).
 *
 * The session is an HMAC-signed `__Host-` cookie minted by `AuthService.mintSession`.
 * In a real app you mint it in `Auth.loginFinish` AFTER `verifyLogin` succeeds;
 * this `/session/dev-login` mints one for a caller-named demo user so the flow is
 * runnable without the external account store the login example stubs out.
 *
 * The server secret defaults to a well-known DEV placeholder; a real deployment
 * calls `AuthService.setSecret(...)` once at startup (see server/main.ts).
 */

// @user: the authenticated-user shape. Exactly one per program. Exported so
// other routes (the PQ login) can mint a session via its generated codec.
@user
export class Account {
    username: string = '';
    admin: bool = false;
    score: u64 = 0;
}

@rest('session')
class Session {
    /** POST /session/dev-login  body: str(username)  -> sets the session cookie.
     *  DEV ONLY: a real app mints in loginFinish after the signature verifies. */
    @post('/dev-login')
    public devLogin(ctx: RouteContext): Response {
        const username = new DataReader(ctx.request.body).readString();
        const u = new Account();
        u.username = username;
        u.admin = username == 'root';
        u.score = 0;

        const data = u.encode();
        const resp = Response.text('ok\n', 200);
        resp.setCookie(AuthService.mintSession(data, 3600)); // HttpOnly signed session
        resp.setCookie(AuthService.userCookie(data, 3600)); // readable companion (client getUser)
        return resp;
    }

    /** GET /session/me  (@auth: 401 without a valid session) -> the typed user.
     *  `AuthService.getUser()` is auto-typed to `Account` with no type argument. */
    @auth
    @get('/me')
    public me(_ctx: RouteContext): Response {
        const u = AuthService.getUser();
        if (u == null) return Response.text('no session\n', 401);
        const w = new DataWriter();
        w.writeString(u.username);
        w.writeBool(u.admin);
        w.writeU64(u.score);
        return Response.bytes(w.toBytes());
    }

    /** POST /session/logout  (@auth) -> clears the session cookie. */
    @auth
    @post('/logout')
    public logout(_ctx: RouteContext): Response {
        const resp = Response.text('bye\n', 200);
        resp.setCookie(AuthService.clearSession());
        resp.setCookie(AuthService.clearUserCookie());
        return resp;
    }
}
