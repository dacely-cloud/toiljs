import { SecureCookies, Cookie, SameSite, RouteContext } from 'toiljs/server/runtime';
import { DataReader } from 'data';

@external('env', 'google_verify')
declare function googleVerify(tp: usize, tl: i32, ap: usize, al: i32, np: usize, nl: i32, out: usize, cap: i32): i32;

export class GoogleClaims {
    sub: string = '';
    email: string = '';
    issuedAt: u64 = 0;
    nonce: string = '';
    emailAuthoritative: bool = false;
}

/** Browser-bound, short-lived nonce. Startup costs zero database operations. */
export class GoogleIdentity {
    static clientId(): string {
        const id = Environment.get('AUTH_GOOGLE_CLIENT_ID');
        return id == null ? '' : id;
    }
    private static secret(): Uint8Array {
        const secret = Environment.getSecure('AUTH_SESSION_SECRET');
        if (secret == null || secret.length < 32) throw new Error('Google login requires AUTH_SESSION_SECRET');
        return crypto.sha256Text('toil-google-state-v1\x00' + secret);
    }
    private static secure(ctx: RouteContext): bool {
        const url = Environment.get('PUBLIC_BASE_URL');
        return ctx.request.header('x-forwarded-proto') == 'https' || (url != null && url.startsWith('https://'));
    }
    private static name(ctx: RouteContext): string {
        return GoogleIdentity.secure(ctx) ? '__Host-toil_google' : 'toil_google';
    }
    static cookie(ctx: RouteContext, value: string, ttl: i64): Cookie {
        let c = Cookie.create('toil_google', value).httpOnly().sameSite(SameSite.Strict).path('/').maxAge(ttl);
        if (GoogleIdentity.secure(ctx)) c = c.asHostPrefixed();
        return c;
    }
    static start(ctx: RouteContext, realm: string, nonce: string): Cookie {
        const value = realm + '|' + (<u64>(Date.now() / 1000) + 120).toString() + '|' + nonce;
        return GoogleIdentity.cookie(ctx, SecureCookies.signed(GoogleIdentity.secret()).sign(GoogleIdentity.name(ctx), value), 120);
    }
    static verify(ctx: RouteContext, realm: string, token: Uint8Array): GoogleClaims | null {
        if (token.length > 16384) return null;
        const name = GoogleIdentity.name(ctx);
        const cookie = ctx.request.cookie(name);
        if (cookie == null) return null;
        const value = SecureCookies.signed(GoogleIdentity.secret()).unsign(name, cookie);
        if (value == null) return null;
        const parts = value.split('|');
        if (parts.length != 3 || parts[0] != realm || U64.parseInt(parts[1]) <= <u64>(Date.now() / 1000) || parts[2].length != 64) return null;
        const t = token;
        const a = Uint8Array.wrap(String.UTF8.encode(GoogleIdentity.clientId()));
        const n = Uint8Array.wrap(String.UTF8.encode(parts[2]));
        const out = new Uint8Array(1024);
        const len = googleVerify(t.dataStart, t.length, a.dataStart, a.length, n.dataStart, n.length, out.dataStart, out.length);
        if (len < 1 || len > out.length) return null;
        const r = new DataReader(out.subarray(0, len));
        const claims = new GoogleClaims();
        claims.sub = r.readString(); claims.email = r.readString(); claims.issuedAt = r.readU64(); claims.nonce = parts[2];
        claims.emailAuthoritative = r.readU8() == 1;
        return r.ok ? claims : null;
    }
}
