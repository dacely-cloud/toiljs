// Pure cookie logic (builder, parser, codec, validation, Request/Response
// integration). Imports the specific modules rather than the runtime index so
// `securecookies.ts` is not pulled into the as-pect graph: it depends on the
// toilscript crypto std (`crypto` / `data` / `bindings/webcrypto`), which the
// as-pect compiler does not ship. `SecureCookies`
// is exercised end-to-end against the real toilscript-compiled wasm in
// `test/devserver.test.ts`.
import { Method, Request, Header } from '../../server/runtime/request';
import { Response } from '../../server/runtime/response';
import { Cookie, SameSite, CookieEncoding } from '../../server/runtime/http/cookie';
import { Cookies } from '../../server/runtime/http/cookies';

// --- helpers ----------------------------------------------------------------

function headerValue(r: Response, name: string): string {
    for (let i = 0; i < r.headers.length; i++) {
        if (r.headers[i].name == name) return r.headers[i].value;
    }
    return '';
}

function headerCount(r: Response, name: string): i32 {
    let n = 0;
    for (let i = 0; i < r.headers.length; i++) {
        if (r.headers[i].name == name) n++;
    }
    return n;
}

function reqWithCookie(value: string): Request {
    const headers = new Array<Header>();
    headers.push(new Header('Cookie', value));
    return new Request(Method.GET, '/', headers, new Uint8Array(0));
}

// --- Cookie builder / serialize --------------------------------------------

describe('Cookie.serialize', () => {
    it('serializes a bare name=value', () => {
        expect<string>(Cookie.create('a', 'b').serialize()).toStrictEqual('a=b');
    });

    it('percent-encodes the value by default', () => {
        expect<string>(Cookie.create('x', 'hello world').serialize()).toStrictEqual('x=hello%20world');
    });

    it('leaves a Raw value untouched', () => {
        expect<string>(
            Cookie.create('x', 'abc').withEncoding(CookieEncoding.Raw).serialize(),
        ).toStrictEqual('x=abc');
    });

    it('base64url-encodes when asked', () => {
        expect<string>(
            Cookie.create('x', 'hi').withEncoding(CookieEncoding.Base64Url).serialize(),
        ).toStrictEqual('x=aGk');
    });

    it('emits attributes in a stable order', () => {
        const s = Cookie.create('a', 'b')
            .domain('example.com')
            .path('/p')
            .secure()
            .httpOnly()
            .sameSite(SameSite.Lax)
            .maxAge(60)
            .serialize();
        expect<string>(s).toStrictEqual('a=b; Domain=example.com; Path=/p; Max-Age=60; SameSite=Lax; Secure; HttpOnly');
    });

    it('auto-adds Secure for SameSite=None', () => {
        expect<string>(Cookie.create('a', 'b').sameSite(SameSite.None).serialize()).toStrictEqual(
            'a=b; SameSite=None; Secure',
        );
    });

    it('auto-adds Secure for Partitioned (CHIPS)', () => {
        expect<string>(Cookie.create('a', 'b').partitioned().serialize()).toStrictEqual(
            'a=b; Secure; Partitioned',
        );
    });

    it('formats Expires from epoch seconds as an IMF-fixdate', () => {
        expect<string>(Cookie.create('a', 'b').expires(784111777).serialize()).toStrictEqual(
            'a=b; Expires=Sun, 06 Nov 1994 08:49:37 GMT',
        );
    });

    it('formats the epoch as the IMF-fixdate zero point', () => {
        expect<string>(Cookie.create('a', 'b').expires(0).serialize()).toStrictEqual(
            'a=b; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        );
    });

    it('clamps Max-Age to the 400-day cap', () => {
        expect<string>(Cookie.create('a', 'b').maxAge(99999999).serialize()).toStrictEqual(
            'a=b; Max-Age=34560000',
        );
    });

    it('applies the __Host- prefix with its required attributes', () => {
        expect<string>(Cookie.create('sid', 'x').asHostPrefixed().serialize()).toStrictEqual(
            '__Host-sid=x; Path=/; Secure',
        );
    });

    it('applies the __Secure- prefix', () => {
        expect<string>(Cookie.create('sid', 'x').asSecurePrefixed().serialize()).toStrictEqual(
            '__Secure-sid=x; Secure',
        );
    });

    it('emits Priority and extension attributes', () => {
        expect<string>(
            Cookie.create('a', 'b').priority('High').extension('CustomFlag').serialize(),
        ).toStrictEqual('a=b; Priority=High; CustomFlag');
    });

    it('percent-encodes CR/LF in a default-encoded value (no header injection)', () => {
        expect<string>(Cookie.create('a', 'b\r\nc').serialize()).toStrictEqual('a=b%0D%0Ac');
    });

    it('strips control characters from a raw value', () => {
        expect<string>(
            Cookie.create('a', 'b\r\nInjected').withEncoding(CookieEncoding.Raw).serialize(),
        ).toStrictEqual('a=bInjected');
    });

    it('strips control characters from the name', () => {
        expect<string>(new Cookie('a\r\nb', 'v').serialize()).toStrictEqual('ab=v');
    });

    it('strips semicolons from a raw value (no attribute injection)', () => {
        expect<string>(
            Cookie.create('a', 'b; Secure').withEncoding(CookieEncoding.Raw).serialize(),
        ).toStrictEqual('a=b Secure');
    });

    it('reduces the name to token chars (no attribute injection)', () => {
        expect<string>(new Cookie('a;Domain=evil', 'v').serialize()).toStrictEqual('aDomainevil=v');
    });
});

// --- validation -------------------------------------------------------------

describe('Cookie.validate', () => {
    it('accepts a well-formed cookie', () => {
        expect<bool>(Cookie.create('ok', 'v').validate().valid).toBe(true);
    });

    it('rejects a name that is not a token', () => {
        expect<bool>(Cookie.create('bad name', 'v').validate().valid).toBe(false);
    });

    it('rejects an empty name', () => {
        expect<bool>(Cookie.create('', 'v').validate().valid).toBe(false);
    });

    it('rejects a Path that does not start with /', () => {
        expect<bool>(Cookie.create('a', 'b').path('nope').validate().valid).toBe(false);
    });

    it('rejects name+value over 4096 bytes', () => {
        expect<bool>(Cookie.create('a', 'x'.repeat(5000)).validate().valid).toBe(false);
    });

    it('rejects a __Host- name without its required attributes', () => {
        const v = new Cookie('__Host-x', 'v').validate();
        expect<bool>(v.valid).toBe(false);
        expect<bool>(v.errors.length > 0).toBe(true);
    });

    it('accepts a correctly-formed __Host- cookie', () => {
        expect<bool>(Cookie.create('x', 'v').asHostPrefixed().validate().valid).toBe(true);
    });

    it('flags a Max-Age beyond the 400-day cap', () => {
        expect<bool>(Cookie.create('a', 'b').maxAge(99999999).validate().valid).toBe(false);
    });
});

// --- Cookies.parse ----------------------------------------------------------

describe('Cookies.parse', () => {
    it('parses multiple cookies', () => {
        const m = Cookies.parse('a=1; b=2');
        expect<i32>(m.size).toBe(2);
        expect<string>(m.get('a')!).toStrictEqual('1');
        expect<string>(m.get('b')!).toStrictEqual('2');
    });

    it('returns null for a missing cookie', () => {
        expect<bool>(Cookies.parse('a=1').get('x') == null).toBe(true);
    });

    it('keeps everything after the first = in the value', () => {
        expect<string>(Cookies.parse('token=ab=cd').get('token')!).toStrictEqual('ab=cd');
    });

    it('trims surrounding whitespace around name and value', () => {
        expect<string>(Cookies.parse('  a = 1 ; b=2').get('a')!).toStrictEqual('1');
    });

    it('strips one layer of surrounding quotes', () => {
        expect<string>(Cookies.parse('a="hello"').get('a')!).toStrictEqual('hello');
    });

    it('percent-decodes values', () => {
        expect<string>(Cookies.parse('x=hello%20world').get('x')!).toStrictEqual('hello world');
    });

    it('keeps the first occurrence of a duplicate name', () => {
        expect<string>(Cookies.parse('a=1; a=2').get('a')!).toStrictEqual('1');
    });

    it('handles an empty header', () => {
        expect<i32>(Cookies.parse('').size).toBe(0);
    });

    it('handles a valueless cookie', () => {
        const m = Cookies.parse('flag');
        expect<bool>(m.has('flag')).toBe(true);
        expect<string>(m.get('flag')!).toStrictEqual('');
    });
});

// --- value codec ------------------------------------------------------------

describe('Cookies value codec', () => {
    it('percent-encodes special characters', () => {
        expect<string>(Cookies.encodeValue('a b&c')).toStrictEqual('a%20b%26c');
    });

    it('round-trips arbitrary UTF-8', () => {
        const original = 'héllo, world! +/=';
        expect<string>(Cookies.decodeValue(Cookies.encodeValue(original))).toStrictEqual(original);
    });
});

// --- parseSetCookie ---------------------------------------------------------

describe('Cookies.parseSetCookie', () => {
    it('round-trips a serialized cookie', () => {
        const wire = Cookie.create('a', 'hello world')
            .domain('x.com')
            .path('/')
            .secure()
            .httpOnly()
            .sameSite(SameSite.Lax)
            .maxAge(60)
            .serialize();
        expect<string>(Cookies.parseSetCookie(wire).serialize()).toStrictEqual(wire);
    });

    it('parses individual attributes', () => {
        const c = Cookies.parseSetCookie('sid=abc; Path=/; HttpOnly; SameSite=Strict');
        expect<string>(c.name).toStrictEqual('sid');
        expect<string>(c.value).toStrictEqual('abc');
    });
});

// --- Request / Response integration -----------------------------------------

describe('Request cookies', () => {
    it('reads a cookie by name', () => {
        expect<string>(reqWithCookie('a=1; b=2').cookie('a')!).toStrictEqual('1');
    });

    it('returns null for a missing cookie', () => {
        expect<bool>(reqWithCookie('a=1').cookie('missing') == null).toBe(true);
    });

    it('exposes the full jar', () => {
        expect<i32>(reqWithCookie('a=1; b=2; c=3').cookies().size).toBe(3);
    });
});

describe('Response cookies', () => {
    it('adds a Set-Cookie header', () => {
        const r = Response.text('x').setCookie(Cookie.create('a', 'b'));
        expect<string>(headerValue(r, 'set-cookie')).toStrictEqual('a=b');
    });

    it('emits one Set-Cookie header per cookie (never folded)', () => {
        const r = Response.empty(200)
            .setCookie(Cookie.create('a', 'b'))
            .setCookie(Cookie.create('c', 'd'));
        expect<i32>(headerCount(r, 'set-cookie')).toBe(2);
    });

    it('setCookieKV is a shorthand', () => {
        const r = Response.empty(200).setCookieKV('a', 'b');
        expect<string>(headerValue(r, 'set-cookie')).toStrictEqual('a=b');
    });

    it('clearCookie emits an expired cookie', () => {
        const r = Response.empty(200).clearCookie('a');
        expect<string>(headerValue(r, 'set-cookie')).toStrictEqual(
            'a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0',
        );
    });
});
