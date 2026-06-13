/**
 * Regression test for the bignum JSON wire format. 64-bit-and-up integers
 * (u64/i64/u128/i128/u256/i256) must cross JSON as DECIMAL STRINGS, not number tokens
 * or limb arrays: JSON numbers ride through a browser client's JSON.parse as IEEE
 * doubles, which silently corrupt any integer past 2^53.
 *
 * Compiles test/fixtures/bignum-wire/spec.ts with the installed toilscript (so it
 * exercises the published compiler + generated client, not a hand-written stub), then
 * imports the generated TS client and asserts the wire shape both directions, including
 * values far above 2^53 and the legacy limb-array shape older servers emitted.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = path.join(here, 'fixtures', 'bignum-wire', 'spec.ts');
// The generated module imports DataWriter/DataReader from this specifier.
const codec = path.join(here, '..', 'src', 'io', 'codec.ts');

/** Resolves the installed toilscript CLI entry (no PATH / .bin assumptions). */
function toilscriptBin(): string {
    const pkgPath = require.resolve('toilscript/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { bin?: Record<string, string> };
    const binRel = pkg.bin?.toilscript;
    if (!binRel) throw new Error('toilscript declares no bin');
    return path.join(path.dirname(pkgPath), binRel);
}

interface Wallet {
    u: bigint;
    i: bigint;
    a: bigint;
    b: bigint;
    c: bigint;
    d: bigint;
    label: string;
    toJSONValue(): Record<string, unknown>;
}
interface WalletStatic {
    new (): Wallet;
    fromJSONValue(v: unknown): Wallet;
}
interface AccountStatic {
    new (): { main: Wallet; ids: bigint[]; toJSONValue(): Record<string, unknown> };
    fromJSONValue(v: unknown): { main: Wallet; ids: bigint[] };
}

let Wallet: WalletStatic;
let Account: AccountStatic;
let tmp: string;

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bignum-wire-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }\n');
    // vitest transforms the imported .ts through Vite/oxc, which walks up for a tsconfig.
    fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'esnext', module: 'esnext' } }),
    );
    const mod = path.join(tmp, 'server.ts');
    const wasm = path.join(tmp, 'spec.wasm');
    const res = spawnSync(
        process.execPath,
        [
            toilscriptBin(),
            spec,
            '-o',
            wasm,
            '--runtime',
            'stub',
            '--initialMemory',
            '32',
            '--rpcModule',
            mod,
            '--rpcRuntime',
            codec,
        ],
        { encoding: 'utf8' },
    );
    if (res.status !== 0) throw new Error('toilscript compile failed:\n' + res.stderr);
    const gen = (await import(pathToFileURL(mod).href)) as {
        Wallet: WalletStatic;
        Account: AccountStatic;
    };
    Wallet = gen.Wallet;
    Account = gen.Account;
});

// A few representative bignum types; `huge` is well past Number.MAX_SAFE_INTEGER.
const huge = '123456789012345678901234567890';
const u128Max = '340282366920938463463374607431768211455';
const i64Min = '-9223372036854775808';

describe('generated client bignum JSON wire format', () => {
    it('serializes every 64-bit-and-up integer as a decimal string', () => {
        const w = new Wallet();
        w.u = BigInt(huge.slice(0, 19)); // fits u64
        w.i = BigInt(i64Min);
        w.a = BigInt(u128Max);
        w.b = -123n;
        w.c = BigInt(huge);
        w.d = -1n;
        w.label = 'x';
        const json = w.toJSONValue();
        // Each bignum field is a string, never a number or an array.
        for (const k of ['u', 'i', 'a', 'b', 'c', 'd'] as const) {
            expect(typeof json[k], `field ${k}`).toBe('string');
        }
        expect(json.a).toBe(u128Max);
        expect(json.c).toBe(huge);
        expect(json.i).toBe(i64Min);
        expect(json.label).toBe('x');
    });

    it('revives a decimal string past 2^53 into an exact bigint', () => {
        const w = Wallet.fromJSONValue({
            u: '0',
            i: i64Min,
            a: u128Max,
            b: '-123',
            c: huge,
            d: '-1',
            label: 'y',
        });
        expect(w.c).toBe(BigInt(huge));
        expect(w.a).toBe(BigInt(u128Max));
        expect(w.i).toBe(BigInt(i64Min));
        expect(w.d).toBe(-1n);
    });

    it('round-trips a value through send then revive without loss', () => {
        const w = new Wallet();
        w.c = BigInt(huge);
        w.d = BigInt('-' + huge);
        const back = Wallet.fromJSONValue(JSON.parse(JSON.stringify(w.toJSONValue())));
        expect(back.c).toBe(BigInt(huge));
        expect(back.d).toBe(BigInt('-' + huge));
    });

    it('still revives the legacy little-endian limb-array shape (back-compat)', () => {
        // u256 [5,0,4,0] little-endian = 5 + 4*2^128.
        const w = Wallet.fromJSONValue({ c: [5, 0, 4, 0], a: [9, 1] });
        expect(w.c).toBe(2n ** 130n + 5n);
        expect(w.a).toBe(2n ** 64n + 9n);
    });

    it('recurses into nested @data and arrays of bignums', () => {
        const a = new Account();
        a.main.c = BigInt(huge);
        a.ids = [1n, BigInt(huge)];
        const json = a.toJSONValue();
        const main = json.main as Record<string, unknown>;
        expect(main.c).toBe(huge);
        expect(json.ids).toEqual(['1', huge]);
        const back = Account.fromJSONValue(JSON.parse(JSON.stringify(json)));
        expect(back.main.c).toBe(BigInt(huge));
        expect(back.ids).toEqual([1n, BigInt(huge)]);
    });
});
