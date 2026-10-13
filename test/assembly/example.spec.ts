// Imports the specific modules rather than the runtime index: the index
// re-exports `SecureCookies`, which depends on the toilscript crypto std the
// as-pect compiler does not ship (see test/assembly/cookie.spec.ts).
import { describe, it, expect } from './aspect-shim';
import { Method } from '../../server/runtime/request';
import { Response } from '../../server/runtime/response';
import { Header } from '../../server/runtime/request';

describe('server runtime', () => {
    it('numbers the HTTP methods per the wire contract', () => {
        expect<i32>(<i32>Method.GET).toBe(0);
        expect<i32>(<i32>Method.POST).toBe(1);
        expect<i32>(<i32>Method.HEAD).toBe(5);
    });

    it('builds a 200 text response by default', () => {
        expect<i32>(<i32>Response.text('hi').status).toBe(200);
    });

    it('defaults notFound() to 404', () => {
        expect<i32>(<i32>Response.notFound().status).toBe(404);
    });

    it('replaces every matching header regardless of casing', () => {
        const headers = [
            new Header('Content-Type', 'old'),
            new Header('content-type', 'older'),
            new Header('x-test', 'keep'),
        ];
        const r = new Response(200, new Uint8Array(0), headers).setHeader(
            'CONTENT-TYPE',
            'image/png',
        );
        expect<i32>(r.headers.length).toBe(2);
        expect<string>(r.headers[0].name).toStrictEqual('x-test');
        expect<string>(r.headers[1].value).toStrictEqual('image/png');
    });

    it('accepts a binary content type and preserves the existing status argument', () => {
        const body = new Uint8Array(2);
        const r = Response.bytes(body, 201, 'image/png');
        expect<i32>(<i32>r.status).toBe(201);
        expect<string>(r.headers[0].value).toStrictEqual('image/png');
        expect<string>(Response.bytes(body).headers[0].value).toStrictEqual(
            'application/octet-stream',
        );
        r.setHeader('Content-Type', 'image/jpeg');
        expect<i32>(r.headers.length).toBe(1);
        expect<string>(r.headers[0].value).toStrictEqual('image/jpeg');
    });
});
