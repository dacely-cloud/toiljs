/**
 * WASM dev server: envelope codec (byte-for-byte against the ABI shared with
 * `server/runtime/envelope.ts` and the edge's `envelope.rs`) and real dispatch
 * into the example project's ToilScript-compiled server wasm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    decodeResponseEnvelope,
    encodeRequestEnvelope,
    unpackHandleResult,
    WasmServerModule,
} from '../src/devserver/index.js';

const EXAMPLE_WASM = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../examples/basic/build/server/release.wasm',
);

describe('request envelope encoding', () => {
    it('encodes a minimal GET / exactly like the edge', () => {
        const out = encodeRequestEnvelope({
            method: 'GET',
            path: '/',
            headers: [],
            body: new Uint8Array(0),
        });
        // Mirrors envelope.rs `encode_minimal_get`.
        expect(out.length).toBe(10);
        expect(out[0]).toBe(0); // method GET
        expect(out.readUInt16LE(1)).toBe(1); // path_len
        expect(out.toString('utf8', 3, 4)).toBe('/');
        expect(out.readUInt16LE(4)).toBe(0); // n_headers
        expect(out.readUInt32LE(6)).toBe(0); // body_len
    });

    it('encodes a POST with a header and body exactly like the edge', () => {
        const out = encodeRequestEnvelope({
            method: 'POST',
            path: '/api',
            headers: [['host', 'example.com']],
            body: new TextEncoder().encode('hi'),
        });
        // Mirrors envelope.rs `encode_post_with_body_and_host`.
        expect(out[0]).toBe(1); // method POST
        expect(out.readUInt16LE(1)).toBe(4);
        expect(out.toString('utf8', 3, 7)).toBe('/api');
        expect(out.readUInt16LE(7)).toBe(1); // n_headers
        expect(out.readUInt16LE(9)).toBe(4); // name_len
        expect(out.readUInt16LE(11)).toBe(11); // val_len
        expect(out.toString('utf8', 13, 17)).toBe('host');
        expect(out.toString('utf8', 17, 28)).toBe('example.com');
        expect(out.readUInt32LE(28)).toBe(2); // body_len
        expect(out.toString('utf8', 32, 34)).toBe('hi');
    });

    it('rejects an unsupported method and oversized fields', () => {
        const base = { path: '/', headers: [], body: new Uint8Array(0) } as const;
        expect(() => encodeRequestEnvelope({ ...base, method: 'TRACE' })).toThrow(/unsupported/);
        expect(() =>
            encodeRequestEnvelope({ ...base, method: 'GET', path: '/'.repeat(0x10000) }),
        ).toThrow(/path too long/);
        expect(() =>
            encodeRequestEnvelope({
                ...base,
                method: 'GET',
                headers: [['x', 'y'.repeat(0x10000)]],
            }),
        ).toThrow(/header too long/);
    });
});

/** Hand-builds a response envelope (the layout the guest writes). */
function buildResponse(status: number, headers: [string, string][], body: Uint8Array): Buffer {
    const parts: Buffer[] = [];
    const u16 = (v: number): Buffer => {
        const b = Buffer.allocUnsafe(2);
        b.writeUInt16LE(v);
        return b;
    };
    const u32 = (v: number): Buffer => {
        const b = Buffer.allocUnsafe(4);
        b.writeUInt32LE(v);
        return b;
    };
    parts.push(u16(status), u16(headers.length));
    for (const [n, v] of headers) {
        parts.push(u16(Buffer.byteLength(n)), u16(Buffer.byteLength(v)));
        parts.push(Buffer.from(n), Buffer.from(v));
    }
    parts.push(u32(body.length), Buffer.from(body));
    return Buffer.concat(parts);
}

describe('response envelope decoding', () => {
    it('round-trips status, headers and body', () => {
        const buf = buildResponse(
            201,
            [
                ['content-type', 'application/json'],
                ['x-trace', 'abc'],
            ],
            new TextEncoder().encode('{"ok":true}'),
        );
        const resp = decodeResponseEnvelope(buf);
        expect(resp.status).toBe(201);
        expect(resp.headers).toEqual([
            ['content-type', 'application/json'],
            ['x-trace', 'abc'],
        ]);
        expect(Buffer.from(resp.body).toString()).toBe('{"ok":true}');
    });

    it('rejects truncation, zero status, and overflowing lengths', () => {
        expect(() => decodeResponseEnvelope(new Uint8Array([1]))).toThrow(/truncated/);
        expect(() => decodeResponseEnvelope(buildResponse(0, [], new Uint8Array(0)))).toThrow(
            /status 0/,
        );
        // Claim a huge header name with too few bytes behind it.
        const bad = Buffer.concat([
            Buffer.from([200, 0, 1, 0, 255, 255, 0, 0]),
            Buffer.from('hi'),
        ]);
        expect(() => decodeResponseEnvelope(bad)).toThrow(/truncated/);
    });
});

describe('handle() result unpacking', () => {
    it('splits the packed i64 into pointer and length', () => {
        expect(unpackHandleResult((65536n << 32n) | 8n)).toEqual({ ptr: 65536, len: 8 });
        expect(unpackHandleResult(0n)).toEqual({ ptr: 0, len: 0 });
        expect(unpackHandleResult(0xffffffff_ffffffffn)).toEqual({
            ptr: 0xffffffff,
            len: 0xffffffff,
        });
    });
});

describe.skipIf(!fs.existsSync(EXAMPLE_WASM))('dispatch into the example server wasm', () => {
    const load = (): WasmServerModule => {
        const m = new WasmServerModule(EXAMPLE_WASM);
        m.refresh();
        return m;
    };
    const get = (m: WasmServerModule, p: string) =>
        m.dispatch({
            method: 'GET',
            path: p,
            headers: [['host', 'localhost:3000']],
            body: new Uint8Array(0),
        });

    it('serves a plain route', () => {
        const r = get(load(), '/');
        expect(r.status).toBe(200);
        expect(r.unhandled).toBe(false);
        expect(Buffer.from(r.body).toString()).toBe('hello from toiljs\n');
    });

    it('serves a @rest route with its content-type', () => {
        const r = get(load(), '/leaderboard');
        expect(r.status).toBe(200);
        expect(r.headers.some(([n, v]) => n === 'content-type' && v.includes('json'))).toBe(true);
    });

    it('marks a route miss as unhandled and strips the marker header', () => {
        const r = get(load(), '/definitely-missing');
        expect(r.status).toBe(404);
        expect(r.unhandled).toBe(true);
        expect(r.headers.some(([n]) => n === 'x-toil-unhandled')).toBe(false);
    });

    it('dispatches a POST body through the envelope', () => {
        const m = load();
        const r = m.dispatch({
            method: 'POST',
            path: '/players',
            headers: [
                ['host', 'localhost:3000'],
                ['content-type', 'application/json'],
            ],
            body: new TextEncoder().encode('{"name":"ada"}'),
        });
        expect(r.unhandled).toBe(false);
        expect(r.status).toBeGreaterThanOrEqual(200);
        expect(r.status).toBeLessThan(500);
    });

    it('keeps requests isolated across instances (fresh state per dispatch)', () => {
        const m = load();
        const a = get(m, '/json');
        const b = get(m, '/json');
        expect(Buffer.from(a.body).toString()).toBe(Buffer.from(b.body).toString());
    });
});
