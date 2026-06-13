import { Method, Request, Response, Rest, ToilHandler } from 'toiljs/server/runtime';

/**
 * The app's request handler: every request enters here. `@rest` controllers (see
 * `routes/`) are tried first via `Rest.dispatch`; whatever they do not claim falls
 * through to the hand-rolled demo endpoints below, then yields to the client.
 */
export class AppHandler extends ToilHandler {
    public handle(req: Request): Response {
        // Rest.dispatch returns the first matching route's Response, or null if nothing
        // matched - then we fall through to our own logic. REST composes; it never takes
        // over handle().
        const hit = Rest.dispatch(req);
        if (hit != null) {
            return hit;
        }

        if (req.method != Method.GET && req.method != Method.HEAD) {
            return Response.empty(405).setHeader('allow', 'GET, HEAD');
        }

        if (req.path == '/json') {
            return Response.json('{"hello":"toiljs"}\n');
        }

        if (req.path == '/echo') {
            return Response.text('you GET ' + req.path + '\n');
        }

        // Web Crypto demo. `crypto` is a global (no import), synchronous: the
        // same SubtleCrypto-style API the browser has, running in the server
        // wasm via metered host functions.
        if (req.path == '/api/hash') {
            const digest = crypto.sha256Text(req.path);
            return Response.json('{"sha256":"' + crypto.toHex(digest) + '"}\n');
        }

        if (req.path == '/api/uuid') {
            return Response.text(crypto.randomUUID() + '\n');
        }

        // Cookies. `Cookie`, `Cookies`, `SecureCookies`, and `SameSite` are ambient
        // globals (no import), exactly like `crypto`. The demo lives in its own
        // method; the client page is `client/routes/cookies.tsx`.
        const cookie = this.cookieDemo(req);
        if (cookie != null) return cookie;

        // Unhandled (not a plain notFound): tells the host this server has no
        // answer for the path, so it may serve it itself. Under `toiljs dev`
        // that falls through to Vite (client routes, assets).
        return Response.unhandled();
    }

    /**
     * The `/api/cookies/*` demo. Each endpoint returns JSON so the client page can
     * render the actual cookie output. Returns `null` for a non-cookie path.
     */
    private cookieDemo(req: Request): Response | null {
        // GALLERY: the serialized `Set-Cookie` output of every capability, no
        // round-trip needed. This is the "everything you can do" reference.
        if (req.path == '/api/cookies/gallery') {
            const labels = new Array<string>();
            const cookies = new Array<string>();

            labels.push('basic');
            cookies.push(Cookie.create('id', 'abc123').serialize());
            labels.push('percent-encoded (default)');
            cookies.push(Cookie.create('msg', 'hello world & more!').serialize());
            labels.push('base64url-encoded');
            cookies.push(Cookie.create('data', 'hello').withEncoding(CookieEncoding.Base64Url).serialize());
            labels.push('raw (no encoding)');
            cookies.push(Cookie.create('tok', 'AAAA.BBBB').withEncoding(CookieEncoding.Raw).serialize());
            labels.push('Max-Age');
            cookies.push(Cookie.create('a', 'b').maxAge(3600).serialize());
            labels.push('Expires (from epoch seconds)');
            cookies.push(Cookie.create('a', 'b').expires(1700000000).serialize());
            labels.push('Domain + Path');
            cookies.push(Cookie.create('a', 'b').domain('example.com').path('/app').serialize());
            labels.push('Secure + HttpOnly');
            cookies.push(Cookie.create('a', 'b').secure().httpOnly().serialize());
            labels.push('SameSite=Strict');
            cookies.push(Cookie.create('a', 'b').sameSite(SameSite.Strict).serialize());
            labels.push('SameSite=None (implies Secure)');
            cookies.push(Cookie.create('a', 'b').sameSite(SameSite.None).serialize());
            labels.push('Partitioned / CHIPS (implies Secure)');
            cookies.push(Cookie.create('a', 'b').partitioned().serialize());
            labels.push('Priority');
            cookies.push(Cookie.create('a', 'b').priority('High').serialize());
            labels.push('__Host- prefix (Secure + Path=/ + no Domain)');
            cookies.push(Cookie.create('sid', 'x').asHostPrefixed().serialize());
            labels.push('__Secure- prefix');
            cookies.push(Cookie.create('sid', 'x').asSecurePrefixed().serialize());
            labels.push('Max-Age clamped to the 400-day cap');
            cookies.push(Cookie.create('a', 'b').maxAge(99999999).serialize());
            labels.push('everything at once');
            cookies.push(
                Cookie.create('full', 'v')
                    .domain('example.com')
                    .path('/')
                    .maxAge(86400)
                    .secure()
                    .httpOnly()
                    .sameSite(SameSite.Lax)
                    .partitioned()
                    .priority('Medium')
                    .extension('CustomFlag')
                    .serialize(),
            );

            let json = '{';
            for (let i = 0; i < labels.length; i++) {
                if (i > 0) json += ',';
                json += '"' + this.esc(labels[i]) + '":"' + this.esc(cookies[i]) + '"';
            }
            json += '}';
            return Response.json(json);
        }

        // SET: store three real cookies on the browser. A plain visit counter
        // (readable by JS), an HMAC-signed session, and an AES-256-GCM-encrypted
        // secret (both HttpOnly, so invisible to JS but readable by the server).
        if (req.path == '/api/cookies/set') {
            const prev = req.cookie('visits');
            let next: string;
            if (prev == null) next = '1';
            else next = (this.toI32(prev) + 1).toString();

            const visits = Cookie.create('visits', next).path('/').sameSite(SameSite.Lax).maxAge(86400);
            const session = SecureCookies.signed(this.demoKey()).seal(
                Cookie.create('session', 'user-42').httpOnly().sameSite(SameSite.Strict).asHostPrefixed(),
            );
            const secret = SecureCookies.encrypted(this.demoKey()).seal(
                Cookie.create('secret', 'top-secret-value').httpOnly().path('/'),
            );

            const json =
                '{"visits":' +
                next +
                ',"emitted":["' +
                this.esc(visits.serialize()) +
                '","' +
                this.esc(session.serialize()) +
                '","' +
                this.esc(secret.serialize()) +
                '"]}';
            return Response.json(json).setCookie(visits).setCookie(session).setCookie(secret);
        }

        // INSPECT: what the server sees. Parses the `Cookie` header, then verifies
        // the signed session (HMAC) and decrypts the secret (AES-GCM) server-side.
        if (req.path == '/api/cookies/inspect') {
            const raw = req.header('cookie');
            const jar = req.cookies();
            const names = jar.names();

            let parsed = '{';
            for (let i = 0; i < names.length; i++) {
                if (i > 0) parsed += ',';
                const val = jar.get(names[i]);
                parsed += '"' + this.esc(names[i]) + '":"' + this.esc(val == null ? '' : val) + '"';
            }
            parsed += '}';

            const session = SecureCookies.signed(this.demoKey()).open(jar, '__Host-session');
            const secret = SecureCookies.encrypted(this.demoKey()).open(jar, 'secret');

            const json =
                '{"raw":"' +
                this.esc(raw == null ? '' : raw) +
                '","count":' +
                names.length.toString() +
                ',"cookies":' +
                parsed +
                ',"session":' +
                (session == null ? 'null' : '"' + this.esc(session) + '"') +
                ',"secret":' +
                (secret == null ? 'null' : '"' + this.esc(secret) + '"') +
                '}';
            return Response.json(json);
        }

        // CLEAR: expire the demo cookies (Max-Age=0 + epoch Expires).
        if (req.path == '/api/cookies/clear') {
            const json =
                '{"cleared":["' +
                this.esc(this.clearString('visits')) +
                '","' +
                this.esc(this.clearString('__Host-session')) +
                '","' +
                this.esc(this.clearString('secret')) +
                '"]}';
            return Response.json(json)
                .clearCookie('visits')
                .clearCookie('__Host-session')
                .clearCookie('secret');
        }

        // SEAL: sign and encrypt a value (from `?v=`), then recover both and show
        // that a tampered signature fails to verify. Pure backend crypto, no headers.
        if (req.path.indexOf('/api/cookies/seal') == 0) {
            const value = this.queryValue(req.path, 'v', 'hello toiljs');
            const signer = SecureCookies.signed(this.demoKey());
            const box = SecureCookies.encrypted(this.demoKey());

            const signed = signer.sign('demo', value);
            const encrypted = box.encrypt('demo', value);
            const unsigned = signer.unsign('demo', signed);
            const decrypted = box.decrypt('demo', encrypted);
            const tampered = signer.unsign('demo', this.flip(signed));

            const json =
                '{"value":"' +
                this.esc(value) +
                '","signed":"' +
                this.esc(signed) +
                '","unsigned":' +
                (unsigned == null ? 'null' : '"' + this.esc(unsigned) + '"') +
                ',"encrypted":"' +
                this.esc(encrypted) +
                '","decrypted":' +
                (decrypted == null ? 'null' : '"' + this.esc(decrypted) + '"') +
                ',"tamperVerifies":' +
                (tampered == null ? 'false' : 'true') +
                '}';
            return Response.json(json);
        }

        return null;
    }

    // Demo signing/encryption key: 32 bytes, valid for AES-256-GCM and HMAC. A real
    // app loads a long random secret from config; never hard-code one.
    private demoKey(): Uint8Array {
        return Uint8Array.wrap(String.UTF8.encode('0123456789abcdef0123456789abcdef'));
    }

    /** The `Set-Cookie` string `clearCookie(name)` emits, for display. */
    private clearString(name: string): string {
        return new Cookie(name, '').path('/').maxAge(0).expires(0).serialize();
    }

    /** Flip the first character (tamper a sealed value while keeping it base64url). */
    private flip(s: string): string {
        if (s.length == 0) return 'A';
        const c = s.charCodeAt(0);
        return String.fromCharCode(c == 65 ? 66 : 65) + s.substring(1);
    }

    /** Read `?key=` (or `&key=`) from `path`, percent-decoded, or `fallback`. */
    private queryValue(path: string, key: string, fallback: string): string {
        const q = path.indexOf('?');
        if (q < 0) return fallback;
        const pairs = path.substring(q + 1).split('&');
        const prefix = key + '=';
        for (let i = 0; i < pairs.length; i++) {
            if (pairs[i].indexOf(prefix) == 0) {
                return Cookies.decodeValue(pairs[i].substring(prefix.length));
            }
        }
        return fallback;
    }

    /** Parse a non-negative base-10 integer prefix of `s`. */
    private toI32(s: string): i32 {
        let r = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c < 48 || c > 57) break;
            r = r * 10 + (c - 48);
        }
        return r;
    }

    /** JSON string escaping for the demo's hand-built JSON (incl. all controls). */
    private esc(s: string): string {
        const hex = '0123456789abcdef';
        let out = '';
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c == 34) out += '\\"';
            else if (c == 92) out += '\\\\';
            else if (c == 10) out += '\\n';
            else if (c == 13) out += '\\r';
            else if (c == 9) out += '\\t';
            else if (c < 0x20) out += '\\u00' + hex.charAt((c >> 4) & 0xf) + hex.charAt(c & 0xf);
            else out += String.fromCharCode(c);
        }
        return out;
    }
}
