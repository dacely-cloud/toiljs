/**
 * Dev-server post-quantum auth host mocks: the ML-KEM-768 decapsulation and the
 * RFC 9497 OPRF evaluation must be byte-identical to the production Rust edge
 * (`toil-backend` fips203 / `voprf` crate). The OPRF mock is asserted against the
 * same RFC 9497 Appendix A.1.1 vector the edge test uses — if both match the RFC,
 * the noble client interops with both servers. (Account/challenge persistence is
 * ToilDB now, exercised end-to-end in `pqauth-e2e.test.ts`.)
 */
import { describe, expect, it } from 'vitest';

import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem.js';

import { buildCryptoImports, freshCryptoState } from '../src/devserver/runtime/crypto.js';

type Ref = { memory: WebAssembly.Memory | null };

function freshMem(pages = 4): Ref {
    return { memory: new WebAssembly.Memory({ initial: pages }) };
}
function buf(ref: Ref): Buffer {
    return Buffer.from(ref.memory!.buffer);
}
function put(ref: Ref, ptr: number, bytes: Uint8Array): void {
    buf(ref).set(bytes, ptr);
}
const h2b = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const b2h = (u: Uint8Array): string => Buffer.from(u).toString('hex');

describe('crypto.mlkem_decapsulate dev mock', () => {
    it('recovers the shared secret a noble client encapsulated (wiring round-trip)', () => {
        const ref = freshMem();
        const imports = buildCryptoImports(ref, freshCryptoState());
        const decap = imports['crypto.mlkem_decapsulate'];

        const seed = new Uint8Array(64).fill(9);
        const { publicKey, secretKey } = ml_kem768.keygen(seed);
        const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);

        const ctPtr = 0;
        const skPtr = 4096;
        const outPtr = 16384;
        put(ref, ctPtr, cipherText); // 1088
        put(ref, skPtr, secretKey); // 2400

        const rc = decap(ctPtr, cipherText.length, skPtr, secretKey.length, outPtr);
        expect(rc).toBe(0);
        const got = buf(ref).subarray(outPtr, outPtr + 32);
        expect(b2h(got)).toBe(b2h(sharedSecret));
    });

    it('rejects wrong sizes with -4', () => {
        const ref = freshMem();
        const decap = buildCryptoImports(ref, freshCryptoState())['crypto.mlkem_decapsulate'];
        expect(decap(0, 1087, 4096, 2400, 16384)).toBe(-4);
        expect(decap(0, 1088, 4096, 2399, 16384)).toBe(-4);
    });
});

describe('crypto.voprf_evaluate dev mock (RFC 9497 A.1.1, ristretto255-SHA512)', () => {
    // The interop gate: matching the RFC means the dev mock == the edge ==
    // anything else RFC 9497-conformant (the noble client).
    const SEED = 'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3';
    const KEY_INFO = '74657374206b6579'; // "test key"
    const BLINDED = '609a0ae68c15a3cf6903766461307e5c8bb2f95e7e6550e1ffa2dc99e412803c';
    const EVALUATED = '7ec6578ae5120958eb2db1745758ff379e77cb64fe77b0b2d8cc917ea0869c7e';

    it('matches the RFC evaluated element', () => {
        const ref = freshMem();
        const evaluate = buildCryptoImports(ref, freshCryptoState())['crypto.voprf_evaluate'];

        const seed = h2b(SEED);
        const info = h2b(KEY_INFO);
        const blinded = h2b(BLINDED);
        const seedPtr = 0;
        const infoPtr = 256;
        const blindedPtr = 512;
        const outPtr = 1024;
        put(ref, seedPtr, seed);
        put(ref, infoPtr, info);
        put(ref, blindedPtr, blinded);

        const rc = evaluate(seedPtr, seed.length, infoPtr, info.length, blindedPtr, blinded.length, outPtr);
        expect(rc).toBe(0);
        const got = buf(ref).subarray(outPtr, outPtr + 32);
        expect(b2h(got)).toBe(EVALUATED);
    });

    it('rejects a bad blinded-element length with -4', () => {
        const ref = freshMem();
        const evaluate = buildCryptoImports(ref, freshCryptoState())['crypto.voprf_evaluate'];
        expect(evaluate(0, 32, 256, 8, 512, 31, 1024)).toBe(-4);
    });
});
