import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildHostImports,
    freshDispatchState,
    type MemoryRef,
} from '../src/devserver/runtime/host.js';

/**
 * The dev host warns (once) when the guest reads a framework auth secret that is unset, since the
 * wasm then falls back to a PUBLISHED dev key (see `server/globals/auth.ts`). This is the visible
 * counterpart to the silent fallback: without it, a server running on the dev host would sign
 * sessions under a forgeable key with no signal. The repo root has no `.env.secrets`, so every
 * lookup below is absent.
 */
function setup() {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const ref: MemoryRef = { memory };
    const env = buildHostImports(ref, freshDispatchState()).env as Record<
        string,
        (...a: number[]) => number
    >;
    const buf = Buffer.from(memory.buffer);
    return { env, buf };
}

/** Writes `key` at offset 0 and runs `env_get_secure`, returning its status code. */
function getSecure(env: Record<string, (...a: number[]) => number>, buf: Buffer, key: string): number {
    const b = Buffer.from(key, 'utf8');
    b.copy(buf, 0);
    return env.env_get_secure(0, b.length, 256, 256);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('dev host secret fallback warning', () => {
    it('warns once that an unset AUTH_SESSION_SECRET falls back to a published key', () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        const { env, buf } = setup();

        expect(getSecure(env, buf, 'AUTH_SESSION_SECRET')).toBe(-2); // ABSENT
        // Repeated reads (a fresh wasm instance per request hits this every time) warn only once.
        expect(getSecure(env, buf, 'AUTH_SESSION_SECRET')).toBe(-2);

        const warnings = write.mock.calls
            .map((c) => String(c[0]))
            .filter((s) => s.includes('AUTH_SESSION_SECRET'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('forge');
        expect(warnings[0]).toContain('deployed node');
    });

    it('does not warn for an ordinary (non-framework) absent secret', () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        const { env, buf } = setup();

        expect(getSecure(env, buf, 'STRIPE_KEY')).toBe(-2); // ABSENT, no published default
        const warned = write.mock.calls.some((c) => String(c[0]).includes('STRIPE_KEY'));
        expect(warned).toBe(false);
    });
});
