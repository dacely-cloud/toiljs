/**
 * loadConfig host/port resolution: the dev server AND the self-host (`toiljs start`)
 * bind to a host+port resolved with the precedence CLI flag > env (PORT/HOST) >
 * config (client.host/port) > default (127.0.0.1:3000). These lock that precedence
 * and the env parsing (a blank/garbage PORT must fall through, never bind to 0).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/compiler/config.js';

// An empty dir with no toil.config so loadConfig exercises the env/opts/default path.
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-cfg-'));

describe('loadConfig host/port precedence', () => {
    const savedPort = process.env.PORT;
    const savedHost = process.env.HOST;
    afterEach(() => {
        if (savedPort === undefined) delete process.env.PORT;
        else process.env.PORT = savedPort;
        if (savedHost === undefined) delete process.env.HOST;
        else process.env.HOST = savedHost;
    });

    it('defaults to 127.0.0.1:3000 with no flag / env / config', async () => {
        delete process.env.PORT;
        delete process.env.HOST;
        const cfg = await loadConfig({ root: emptyRoot });
        expect(cfg.port).toBe(3000);
        expect(cfg.host).toBe('127.0.0.1');
    });

    it('reads the PORT / HOST env vars', async () => {
        process.env.PORT = '8080';
        process.env.HOST = '0.0.0.0';
        const cfg = await loadConfig({ root: emptyRoot });
        expect(cfg.port).toBe(8080);
        expect(cfg.host).toBe('0.0.0.0');
    });

    it('CLI opts win over env (CLI > env)', async () => {
        process.env.PORT = '8080';
        process.env.HOST = '0.0.0.0';
        const cfg = await loadConfig({ root: emptyRoot, port: 4321, host: '192.168.1.5' });
        expect(cfg.port).toBe(4321);
        expect(cfg.host).toBe('192.168.1.5');
    });

    it('a blank / non-numeric PORT env falls through to the default (never binds to 0)', async () => {
        process.env.PORT = '';
        delete process.env.HOST;
        expect((await loadConfig({ root: emptyRoot })).port).toBe(3000);
        process.env.PORT = 'not-a-number';
        expect((await loadConfig({ root: emptyRoot })).port).toBe(3000);
    });
});
