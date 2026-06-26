/**
 * @service / @remote RPC: a real round trip into the example project's toilscript-compiled server
 * wasm. A `POST /__toil_rpc` carrying the FNV method id in the `toil-rpc` header is dispatched by the
 * runtime `Rpc` registry (compiler-injected `__rpcDispatch` + `Rpc.register`) to the @remote method,
 * and the @data/scalar result comes back encoded with the same DataWriter codec the client decodes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WasmServerModule } from '../src/devserver/index.js';

const EXAMPLE_WASM = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../examples/basic/build/server/release.wasm',
);

/** FNV-1a (the toilscript `dataTypeId`); the client + the parser injection must agree on this. */
function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h >>> 0;
}

describe.skipIf(!fs.existsSync(EXAMPLE_WASM))('@service RPC dispatch', () => {
    const load = (): WasmServerModule => {
        const m = new WasmServerModule(EXAMPLE_WASM);
        m.refresh();
        return m;
    };

    it('dispatches Server.stats.playerCount() over /__toil_rpc', () => {
        const id = fnv1a('Stats.playerCount');
        expect(id).toBe(118912982); // matches the generated __toilRpc client
        const r = load().dispatch({
            method: 'POST',
            path: '/__toil_rpc',
            headers: [['toil-rpc', String(id)]],
            body: new Uint8Array(0),
        });
        expect(r.unhandled).toBe(false);
        expect(r.status).toBe(200);
        // The result is a DataWriter-encoded i32 (the seeded player count = 3).
        expect(r.body.length).toBe(4);
        const dv = new DataView(r.body.buffer, r.body.byteOffset, r.body.length);
        expect(dv.getInt32(0, true)).toBe(3);
    });

    it('dispatches a free Server.ping(n) over /__toil_rpc', () => {
        const id = fnv1a('ping');
        const body = new Uint8Array(4);
        new DataView(body.buffer).setInt32(0, 41, true); // arg n = 41 (DataWriter writeI32, LE)
        const r = load().dispatch({
            method: 'POST',
            path: '/__toil_rpc',
            headers: [['toil-rpc', String(id)]],
            body,
        });
        expect(r.status).toBe(200);
        expect(r.body.length).toBe(4);
        const dv = new DataView(r.body.buffer, r.body.byteOffset, r.body.length);
        expect(dv.getInt32(0, true)).toBe(42); // ping(41) = 42
    });

    it('round-trips a Uint8Array[] arg + result (writeBytes/readBytes loop, the #5 fix)', () => {
        const id = fnv1a('echoParts');
        const parts = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5])];
        const buf: number[] = [];
        const pushU32 = (v: number) => buf.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
        pushU32(parts.length); // u32 count, then per part: u32 len + bytes (DataWriter.writeBytes)
        for (const p of parts) {
            pushU32(p.length);
            for (const b of p) buf.push(b);
        }
        const r = load().dispatch({
            method: 'POST',
            path: '/__toil_rpc',
            headers: [['toil-rpc', String(id)]],
            body: Uint8Array.from(buf),
        });
        expect(r.status).toBe(200);
        const dv = new DataView(r.body.buffer, r.body.byteOffset, r.body.length);
        let off = 0;
        const count = dv.getUint32(off, true);
        off += 4;
        const out: number[][] = [];
        for (let i = 0; i < count; i++) {
            const len = dv.getUint32(off, true);
            off += 4;
            out.push([...r.body.subarray(off, off + len)]);
            off += len;
        }
        expect(out).toEqual([
            [1, 2],
            [3, 4, 5],
        ]);
    });

    it('rejects an @auth @remote with 401 when there is no session', () => {
        const id = fnv1a('Stats.secretCount');
        const r = load().dispatch({
            method: 'POST',
            path: '/__toil_rpc',
            headers: [['toil-rpc', String(id)]],
            body: new Uint8Array(0),
        });
        expect(r.status).toBe(401);
    });

    it('returns 400 for an unknown method id', () => {
        const r = load().dispatch({
            method: 'POST',
            path: '/__toil_rpc',
            headers: [['toil-rpc', '999999']],
            body: new Uint8Array(0),
        });
        expect(r.status).toBe(400);
    });

    it('does not intercept a non-RPC request (no toil-rpc header)', () => {
        const r = load().dispatch({
            method: 'GET',
            path: '/json',
            headers: [['host', 'localhost:3000']],
            body: new Uint8Array(0),
        });
        expect(r.status).toBe(200);
        expect(Buffer.from(r.body).toString()).toBe('{"hello":"toiljs"}\n');
    });
});
