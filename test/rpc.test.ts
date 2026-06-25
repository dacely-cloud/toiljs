import { afterEach, describe, expect, it } from 'vitest';

import { Server } from '../src/client/rpc';

// `Server` is the runtime behind the generated typed surface. The RPC branch surfaces
// `globalThis.__toilRpc` (attached by the generated `shared/server.ts`); when that client has
// not loaded, the proxy throws a helpful "client has not loaded" error naming the path.
describe('Server RPC stub (client not loaded)', () => {
    afterEach(() => {
        delete (globalThis as { __toilRpc?: unknown }).__toilRpc;
    });

    it('throws on a direct call, naming the path', () => {
        const s = Server as { ping: () => unknown };
        expect(() => s.ping()).toThrow(/Server\.ping\(\)/);
    });

    it('throws on a nested service.method call', () => {
        const s = Server as { accounts: { getUser: () => unknown } };
        expect(() => s.accounts.getUser()).toThrow(/Server\.accounts\.getUser\(\)/);
        expect(() => s.accounts.getUser()).toThrow(/has not loaded/);
    });

    it('surfaces the attached RPC client (service method + free remote) once loaded', async () => {
        const fake = { stats: { playerCount: async () => 3 }, ping: async (n: number) => n + 1 };
        (globalThis as { __toilRpc?: unknown }).__toilRpc = fake;
        const s = Server as {
            stats: { playerCount: () => Promise<number> };
            ping: (n: number) => Promise<number>;
        };
        expect(await s.stats.playerCount()).toBe(3);
        expect(await s.ping(41)).toBe(42);
    });

    it('is not thenable (so it is not mistaken for a promise)', () => {
        const s = Server as Record<string, unknown>;
        expect(s.then).toBeUndefined();
    });

    it('ignores symbol probes without throwing', () => {
        const s = Server as Record<PropertyKey, unknown>;
        expect(s[Symbol.iterator]).toBeUndefined();
    });
});

// `Server.REST` surfaces the working fetch client that the generated `shared/server.ts`
// attaches to `globalThis.__toilRest` on import.
describe('Server.REST surface', () => {
    afterEach(() => {
        delete (globalThis as { __toilRest?: unknown }).__toilRest;
    });

    it('returns the attached REST client when shared/server has loaded', () => {
        const fake = { todos: { getTodo: async () => 'ok' } };
        (globalThis as { __toilRest?: unknown }).__toilRest = fake;
        const s = Server as { REST: typeof fake };
        expect(s.REST).toBe(fake);
        expect(s.REST.todos.getTodo).toBeTypeOf('function');
    });

    it('throws a helpful "not loaded" error when the REST client is absent', () => {
        const s = Server as { REST: { todos: { getTodo: () => unknown } } };
        expect(() => s.REST.todos.getTodo()).toThrow(/Server\.REST\.todos\.getTodo\(\)/);
        expect(() => s.REST.todos.getTodo()).toThrow(/has not loaded/);
    });
});
