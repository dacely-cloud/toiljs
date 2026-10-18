import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { argon2id } from 'hash-wasm';
import { ristretto255_oprf } from '@noble/curves/ed25519.js';
import { ml_dsa44 } from '@dacely/noble-post-quantum/ml-dsa.js';
import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem.js';
import { buildLoginMessage, buildRegisterMessage } from '../src/client/auth.js';
import { buildHostImports, freshDispatchState } from '../src/devserver/runtime/host.js';
import { writeDocs } from '../src/compiler/docs.js';

const vector = JSON.parse(readFileSync(resolve('docs/auth/vectors-v1.json'), 'utf8')) as Record<
    string,
    string | number
>;
const field = (name: string) => Buffer.from(vector[name] as string, 'hex');
it('keeps the protocol guide link resolvable in generated docs and the package export', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-vector-docs-'));
    try {
        writeDocs(root);
        const guide = join(root, 'docs/auth/native-protocol.md');
        const link = /\[vectors-v1\.json\]\(([^)]+)\)/.exec(readFileSync(guide, 'utf8'));
        expect(link).not.toBeNull();
        const generated = JSON.parse(readFileSync(resolve(root, 'docs/auth', link![1]), 'utf8'));
        expect(generated).toEqual(vector);
        const require = createRequire(import.meta.url);
        expect(
            JSON.parse(readFileSync(require.resolve('toiljs/auth/vectors-v1.json'), 'utf8')),
        ).toEqual(vector);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
it('pins the portable client password, OPRF, KDF, ML-DSA, ML-KEM and wire vectors', async () => {
    const password = new TextEncoder().encode((vector.password as string).normalize('NFKC'));
    expect(Buffer.from(password)).toEqual(field('passwordNfkcUtf8'));
    const output = ristretto255_oprf.oprf.finalize(password, field('blind'), field('evaluated'));
    expect(Buffer.from(output)).toEqual(field('oprfOutput'));
    const seed = await argon2id({
        password: output,
        salt: field('salt'),
        memorySize: vector.memKiB as number,
        iterations: vector.iterations as number,
        parallelism: vector.parallelism as number,
        hashLength: 32,
        outputType: 'binary',
    });
    expect(Buffer.from(seed)).toEqual(field('signingSeed'));
    const kp = ml_dsa44.keygen(seed);
    expect(Buffer.from(kp.publicKey)).toEqual(field('mldsaPublicKey'));
    expect(Buffer.from(buildRegisterMessage(vector.username as string, kp.publicKey))).toEqual(
        field('registerMessage'),
    );
    expect(
        Buffer.from(
            buildLoginMessage(
                vector.username as string,
                vector.domain as string,
                field('cid'),
                field('nonce'),
                BigInt(vector.iat),
                BigInt(vector.exp),
                field('ciphertext'),
                vector.memKiB as number,
                vector.iterations as number,
                vector.parallelism as number,
                field('serverKemKeyId'),
            ),
        ),
    ).toEqual(field('loginMessage'));
    const kem = ml_kem768.keygen(field('kemSeed'));
    expect(Buffer.from(kem.publicKey)).toEqual(field('kemPublicKey'));
    const encapsulated = ml_kem768.encapsulate(kem.publicKey, field('encapsulationSeed'));
    expect(Buffer.from(encapsulated.cipherText)).toEqual(field('ciphertext'));
    expect(Buffer.from(encapsulated.sharedSecret)).toEqual(field('sharedSecret'));
});
it('matches the compiled ToilScript server helpers to the portable vectors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-auth-vectors-'));
    try {
        mkdirSync(join(root, 'node_modules'));
        symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
        const bytes = (name: string) => `hex('${vector[name]}')`;
        writeFileSync(
            join(root, 'app.ts'),
            `
function hex(s:string):Uint8Array { const out=new Uint8Array(s.length/2);for(let i=0;i<out.length;i++)out[i]=<u8>parseInt(s.substr(i*2,2),16);return out; }
export function run():void {
  const message=AuthService.buildLoginMessage('${vector.username}','${vector.domain}',${bytes('cid')},${bytes('nonce')},${vector.iat},${vector.exp},${bytes('ciphertext')},${vector.memKiB},${vector.iterations},${vector.parallelism},${bytes('serverKemKeyId')});
  assert(crypto.toHex(message)=='${vector.loginMessage}');
  assert(crypto.toHex(AuthService.buildRegisterMessage('${vector.username}',${bytes('mldsaPublicKey')}))=='${vector.registerMessage}');
  assert(AuthService.verifyRegister(${bytes('mldsaPublicKey')},${bytes('registerMessage')},${bytes('registerSignature')}));
  assert(AuthService.verifyLogin(${bytes('mldsaPublicKey')},message,${bytes('loginSignature')}));
  const hash=AuthService.sha256(message);
  const key=AuthService.deriveSessionKey(${bytes('sharedSecret')},hash);
  assert(crypto.toHex(key)=='${vector.sessionKey}');
  assert(crypto.toHex(AuthService.serverConfirmTag(key,hash))=='${vector.serverConfirm}');
  AuthService.setOprfSeed(${bytes('oprfSeed')});
  assert(crypto.toHex(AuthService.oprfEvaluate('${vector.username}',${bytes('blinded')}))=='${vector.evaluated}');
  AuthService.setServerKemSecretKey(${bytes('kemSecretKey')});
  assert(crypto.toHex(AuthService.mlkemDecapsulate(${bytes('ciphertext')}))=='${vector.sharedSecret}');
  assert(ToilUserId.derive(${bytes('mldsaPublicKey')},'${vector.username}','${vector.domain}').toHex()=='${vector.initialUserId}');
}
`,
        );
        const artifact = join(root, 'app.wasm');
        const compiled = spawnSync(
            process.execPath,
            [
                resolve('node_modules/toilscript/bin/toilscript.js'),
                'app.ts',
                '-o',
                artifact,
                '--runtime',
                'stub',
                '--exportStart',
                '_start',
                '--lib',
                relative(root, resolve('server/globals')),
            ],
            { cwd: root, encoding: 'utf8' },
        );
        expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
        const ref = { memory: null as WebAssembly.Memory | null };
        const { instance } = await WebAssembly.instantiate(
            readFileSync(artifact),
            buildHostImports(ref, freshDispatchState()),
        );
        ref.memory = instance.exports.memory as WebAssembly.Memory;
        (instance.exports._start as () => void)();
        (instance.exports.run as () => void)();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
