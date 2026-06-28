// Imports the specific modules rather than the runtime index: the index
// re-exports `SecureCookies`, which depends on the toilscript crypto std the
// as-pect compiler does not ship (see test/assembly/cookie.spec.ts).
import { describe, it, expect } from './aspect-shim';
import { Method } from '../../server/runtime/request';
import { Response } from '../../server/runtime/response';

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
});
