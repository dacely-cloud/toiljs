import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadBuiltSsrTemplates } from '../src/devserver/production';
import { assembleSsr, type SsrRoute } from '../src/devserver/ssr';

function slotsManifest(tmplLen: number, hash: Buffer): Buffer {
    const buf = Buffer.alloc(46 + 8);
    let o = 0;
    buf.write('TSLT', o, 'ascii');
    o += 4;
    buf.writeUInt16LE(1, o);
    o += 2;
    buf.writeUInt16LE(0, o);
    o += 2;
    buf.writeUInt32LE(tmplLen, o);
    o += 4;
    hash.copy(buf, o);
    o += 32;
    buf.writeUInt16LE(1, o);
    o += 2;
    buf.writeUInt32LE(1, o); // insert after the first byte
    o += 4;
    buf.writeUInt16LE(0, o);
    o += 2;
    buf.writeUInt8(0, o); // text
    o += 1;
    buf.writeUInt8(0, o);
    return buf;
}

function valuesEnvelope(hash: Buffer, value: string): Buffer {
    const valueBytes = Buffer.from(value);
    const buf = Buffer.alloc(2 + 32 + 2 + 2 + 2 + 1 + 4 + valueBytes.length);
    let o = 0;
    buf.writeUInt16LE(200, o);
    o += 2;
    hash.copy(buf, o);
    o += 32;
    buf.writeUInt16LE(0, o); // headers
    o += 2;
    buf.writeUInt16LE(1, o); // slots
    o += 2;
    buf.writeUInt16LE(0, o);
    o += 2;
    buf.writeUInt8(0, o);
    o += 1;
    buf.writeUInt32LE(valueBytes.length, o);
    o += 4;
    valueBytes.copy(buf, o);
    return buf;
}

describe('built SSR templates', () => {
    it('loads the built shell, including production CSS links, from _ssr artifacts', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-built-ssr-'));
        try {
            const dir = path.join(root, '_ssr');
            fs.mkdirSync(dir, { recursive: true });
            const tmpl = Buffer.from(
                '<!doctype html><html><head><link rel="stylesheet" href="/css/style.css"></head><body>A</body></html>',
            );
            const hash = Buffer.alloc(32, 7);
            fs.writeFileSync(
                path.join(dir, 'templates.json'),
                JSON.stringify([{ route: '/x', name: 'x', hash: hash.toString('hex') }]),
            );
            fs.writeFileSync(path.join(dir, 'x.tmpl'), tmpl);
            fs.writeFileSync(path.join(dir, 'x.slots'), slotsManifest(tmpl.length, hash));

            const templates = loadBuiltSsrTemplates(root);
            expect(templates).toHaveLength(1);
            expect(Buffer.from(templates[0]!.tmpl).toString('utf8')).toContain('/css/style.css');
            expect(Buffer.from(templates[0]!.hash!).equals(hash)).toBe(true);
            expect(templates[0]!.entries).toEqual([{ id: 0, offset: 1 }]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('checks the deployed template hash before splicing production SSR values', () => {
        const hash = Buffer.alloc(32, 1);
        const route: SsrRoute = {
            test: () => true,
            tmpl: Buffer.from('ab'),
            entries: [{ id: 0, offset: 1 }],
            hash,
        };

        expect(Buffer.from(assembleSsr(route, valuesEnvelope(hash, 'X'))!.html).toString()).toBe(
            'aXb',
        );
        expect(assembleSsr(route, valuesEnvelope(Buffer.alloc(32, 2), 'X'))).toBeNull();
    });
});
