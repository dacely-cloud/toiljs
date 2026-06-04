import { Method, Response } from '../../server/runtime';

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
