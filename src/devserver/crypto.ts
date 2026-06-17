/**
 * Dev-server mock of the `env.crypto.*` host functions, mirroring the
 * production edge (`toil-backend/src/wasm/host/import_functions/crypto`) and the
 * toilscript std ABI (`std/assembly/crypto/algorithms.ts`). Backed by Node's
 * `crypto`. The dev server intentionally skips the edge's metering, so these
 * charge nothing; results must still be byte-identical to the edge for the
 * common algorithms.
 *
 * Variable-length results use the same two-step pull as the edge: the op
 * returns the length and stashes the bytes; the guest then calls `take_result`.
 *
 * Dev-only limitations: raw-format import of asymmetric keys (EC/Ed25519/
 * X25519) returns the "unsupported" code (-3) here because Node can't import a
 * bare key without DER; use pkcs8/spki in the dev server. The production edge
 * supports raw too. These are catchable guest-side errors, never crashes.
 */

import * as nodeCrypto from 'node:crypto';

import { ml_dsa44 } from '@dacely/noble-post-quantum/ml-dsa.js';
import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem.js';
import { ristretto255_oprf } from '@noble/curves/ed25519.js';

import type { MemoryRef } from './host.js';

// --- ABI id tables (must match the std + Rust backend) ----------------------
const ALG = {
    SHA1: 1, SHA256: 2, SHA384: 3, SHA512: 4, SHA3_256: 5, SHA3_384: 6, SHA3_512: 7,
    AES_GCM: 10, AES_CBC: 11, AES_CTR: 12, AES_KW: 13, HMAC: 20,
    ECDSA: 32, ED25519: 33, ECDH: 50, X25519: 51, HKDF: 52, PBKDF2: 53,
} as const;
const FMT = { RAW: 0, PKCS8: 1, SPKI: 2, JWK: 3 } as const;

// Recoverable error codes (negative returns).
const ERR_GENERIC = -1;
const ERR_UNSUPPORTED = -3;
const ERR_INVALID_PARAMS = -4;
const ERR_OPERATION_FAILED = -5;
const ERR_NOT_EXTRACTABLE = -7;

const MAX_OUTPUT = 1024 * 1024;

interface KeyEntry {
    /** Raw bytes for symmetric/MAC/KDF keys. */
    raw: Buffer | null;
    /** Node KeyObject for asymmetric keys. */
    keyObject: nodeCrypto.KeyObject | null;
    alg: number;
    hash: number;
    extractable: boolean;
    isPrivate: boolean;
}

export interface CryptoState {
    keys: Map<number, KeyEntry>;
    nextHandle: number;
    lastResult: Buffer | null;
}

export function freshCryptoState(): CryptoState {
    return { keys: new Map(), nextHandle: 1, lastResult: null };
}

function memBuf(ref: MemoryRef): Buffer {
    if (!ref.memory) throw new Error('crypto host import called before memory was bound');
    return Buffer.from(ref.memory.buffer);
}

function readBytes(ref: MemoryRef, ptr: number, len: number): Buffer {
    const m = memBuf(ref);
    if (ptr < 0 || len < 0 || ptr + len > m.length)
        throw new Error(`crypto read out of bounds: ptr=${String(ptr)} len=${String(len)}`);
    // Copy out so later writes/grows can't alias the input.
    return Buffer.from(m.subarray(ptr, ptr + len));
}

function writeBytes(ref: MemoryRef, ptr: number, bytes: Buffer | Uint8Array): void {
    const m = memBuf(ref);
    if (ptr < 0 || ptr + bytes.length > m.length)
        throw new Error(`crypto write out of bounds: ptr=${String(ptr)} len=${String(bytes.length)}`);
    m.set(bytes, ptr);
}

/** Little-endian reader over a packed params buffer (mirrors the Rust ParamReader). */
class ParamReader {
    private pos = 0;
    constructor(private readonly buf: Buffer) {}
    /** Bounds-check before a read so a malformed buffer throws a controlled
     *  error (trap-equivalent, caught by the dispatcher) rather than a raw
     *  Node RangeError. */
    private need(n: number): void {
        if (n < 0 || this.pos + n > this.buf.length)
            throw new Error('crypto: malformed params buffer (truncated)');
    }
    readI32(): number {
        this.need(4);
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }
    readU32(): number {
        this.need(4);
        const v = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return v;
    }
    readBlob(): Buffer {
        const n = this.readU32();
        this.need(n);
        const s = Buffer.from(this.buf.subarray(this.pos, this.pos + n));
        this.pos += n;
        return s;
    }
}

function hashName(id: number): string {
    switch (id) {
        case ALG.SHA1: return 'sha1';
        case ALG.SHA256: return 'sha256';
        case ALG.SHA384: return 'sha384';
        case ALG.SHA512: return 'sha512';
        case ALG.SHA3_256: return 'sha3-256';
        case ALG.SHA3_384: return 'sha3-384';
        case ALG.SHA3_512: return 'sha3-512';
        default: throw new Error(`crypto: bad hash id ${String(id)}`);
    }
}

function stash(state: CryptoState, bytes: Buffer): number {
    state.lastResult = bytes;
    return bytes.length;
}

/**
 * Build the `env.crypto.*` import functions. `state.crypto` holds the per-
 * dispatch keystore + result scratch.
 */
export function buildCryptoImports(
    ref: MemoryRef,
    cs: CryptoState,
): Record<string, (...args: number[]) => number | void> {
    return {
        'crypto.fill_random': (outPtr: number, len: number): void => {
            if (len < 0 || len > MAX_OUTPUT) throw new Error('crypto.fill_random: bad length');
            writeBytes(ref, outPtr, nodeCrypto.randomBytes(len));
        },

        'crypto.random_uuid': (outPtr: number): void => {
            writeBytes(ref, outPtr, nodeCrypto.randomBytes(16));
        },

        'crypto.take_result': (outPtr: number, outLen: number): number => {
            const r = cs.lastResult;
            if (!r || r.length !== outLen)
                throw new Error('crypto.take_result: length mismatch');
            writeBytes(ref, outPtr, r);
            cs.lastResult = null;
            return r.length;
        },

        'crypto.digest': (alg: number, dataPtr: number, dataLen: number): number => {
            const data = readBytes(ref, dataPtr, dataLen);
            try {
                return stash(cs, nodeCrypto.createHash(hashName(alg)).update(data).digest());
            } catch {
                return ERR_UNSUPPORTED;
            }
        },

        'crypto.import_key': (
            format: number,
            keyPtr: number,
            keyLen: number,
            paramsPtr: number,
            paramsLen: number,
            extractable: number,
            _usages: number,
        ): number => {
            const key = readBytes(ref, keyPtr, keyLen);
            const pr = new ParamReader(readBytes(ref, paramsPtr, paramsLen));
            const alg = pr.readI32();
            const hash = pr.readI32();
            return importKey(cs, format, alg, hash, pr, key, extractable !== 0);
        },

        'crypto.export_key': (format: number, handle: number): number => {
            const e = cs.keys.get(handle);
            if (!e) throw new Error('crypto.export_key: invalid handle');
            if (!e.extractable) return ERR_NOT_EXTRACTABLE;
            try {
                if (e.raw && format === FMT.RAW) return stash(cs, e.raw);
                if (e.keyObject) {
                    if (format === FMT.PKCS8 && e.isPrivate)
                        return stash(cs, e.keyObject.export({ format: 'der', type: 'pkcs8' }) as Buffer);
                    if (format === FMT.SPKI && !e.isPrivate)
                        return stash(cs, e.keyObject.export({ format: 'der', type: 'spki' }) as Buffer);
                }
                return ERR_UNSUPPORTED;
            } catch {
                return ERR_OPERATION_FAILED;
            }
        },

        'crypto.encrypt': (h: number, pp: number, pl: number, dp: number, dl: number): number =>
            aesOp(cs, ref, true, h, pp, pl, dp, dl),
        'crypto.decrypt': (h: number, pp: number, pl: number, dp: number, dl: number): number =>
            aesOp(cs, ref, false, h, pp, pl, dp, dl),

        'crypto.sign': (h: number, pp: number, pl: number, dp: number, dl: number): number =>
            signOp(cs, ref, h, pp, pl, dp, dl),

        'crypto.verify': (
            h: number, pp: number, pl: number, sp: number, sl: number, dp: number, dl: number,
        ): number => verifyOp(cs, ref, h, pp, pl, sp, sl, dp, dl),

        'crypto.derive_bits': (h: number, pp: number, pl: number, lengthBits: number): number =>
            deriveBitsOp(cs, ref, h, pp, pl, lengthBits),

        // ML-DSA-44 (FIPS 204) verify for the auth primitive. Mirrors the edge
        // host (`mldsa_verify_import.rs`): same size asserts, 1/0/neg result.
        // Backed by the same noble lib the client signs with, so dev == prod.
        'crypto.mldsa_verify': (
            pkPtr: number, pkLen: number,
            msgPtr: number, msgLen: number,
            sigPtr: number, sigLen: number,
            ctxPtr: number, ctxLen: number,
        ): number => {
            if (pkLen !== 1312 || sigLen !== 2420 || ctxLen > 255) return -4;
            try {
                const pk = new Uint8Array(readBytes(ref, pkPtr, pkLen));
                const msg = new Uint8Array(readBytes(ref, msgPtr, msgLen));
                const sig = new Uint8Array(readBytes(ref, sigPtr, sigLen));
                const ctx = new Uint8Array(readBytes(ref, ctxPtr, ctxLen));
                return ml_dsa44.verify(sig, msg, pk, { context: ctx }) ? 1 : 0;
            } catch {
                return -1;
            }
        },

        // ML-KEM-768 (FIPS 203) decapsulation for the mutual-auth + session-key
        // layer. Mirrors the edge host (`mlkem_decapsulate_import.rs` / fips203):
        // recover the 32-byte shared secret from the client's ciphertext using
        // the server's static secret key, write it to `outPtr`, return 0 / neg.
        // Backed by the same noble lib the client encapsulates with (dev == prod).
        'crypto.mlkem_decapsulate': (
            ctPtr: number, ctLen: number,
            skPtr: number, skLen: number,
            outPtr: number,
        ): number => {
            if (ctLen !== 1088 || skLen !== 2400) return -4;
            try {
                const ct = new Uint8Array(readBytes(ref, ctPtr, ctLen));
                const sk = new Uint8Array(readBytes(ref, skPtr, skLen));
                const ss = ml_kem768.decapsulate(ct, sk); // 32 bytes; implicit rejection on bad ct
                writeBytes(ref, outPtr, Buffer.from(ss));
                return 0;
            } catch {
                return -5;
            }
        },

        // RFC 9497 OPRF (mode 0x00, ristretto255-SHA512) server evaluation for
        // the OPAQUE-style keyed salt. Mirrors the edge host
        // (`voprf_evaluate_import.rs` / the `voprf` crate): derive the per-user
        // key from (seed, info=username) and blind-evaluate the client's blinded
        // element, writing the 32-byte evaluated element to `outPtr`. Backed by
        // `@noble/curves` ristretto255_oprf, which matches the edge byte-for-byte
        // (both RFC 9497), so dev == prod.
        'crypto.voprf_evaluate': (
            seedPtr: number, seedLen: number,
            infoPtr: number, infoLen: number,
            blindedPtr: number, blindedLen: number,
            outPtr: number,
        ): number => {
            // seedLen MUST be exactly 32 (RFC 9497 Ns; noble deriveKeyPair rejects
            // other lengths) -- matching the edge so dev and prod never diverge.
            if (blindedLen !== 32 || seedLen !== 32 || infoLen > 512) return -4;
            try {
                const seed = new Uint8Array(readBytes(ref, seedPtr, seedLen));
                const info = new Uint8Array(readBytes(ref, infoPtr, infoLen));
                const blinded = new Uint8Array(readBytes(ref, blindedPtr, blindedLen));
                const oprf = ristretto255_oprf.oprf;
                const kp = oprf.deriveKeyPair(seed, info);
                const evaluated = oprf.blindEvaluate(kp.secretKey, blinded); // 32-byte element
                writeBytes(ref, outPtr, Buffer.from(evaluated));
                return 0;
            } catch {
                return -5;
            }
        },
    };
}

function importKey(
    cs: CryptoState,
    format: number,
    alg: number,
    hash: number,
    pr: ParamReader,
    key: Buffer,
    extractable: boolean,
): number {
    const newEntry = (e: Omit<KeyEntry, 'extractable'>): number => {
        const handle = cs.nextHandle++;
        cs.keys.set(handle, { ...e, extractable });
        return handle;
    };

    try {
        // Symmetric / MAC / KDF: raw bytes.
        if (
            alg === ALG.AES_GCM || alg === ALG.AES_CBC || alg === ALG.AES_CTR ||
            alg === ALG.AES_KW || alg === ALG.HMAC || alg === ALG.PBKDF2 || alg === ALG.HKDF
        ) {
            if (format !== FMT.RAW) return ERR_UNSUPPORTED;
            return newEntry({ raw: key, keyObject: null, alg, hash, isPrivate: false });
        }

        // Asymmetric: pkcs8 (private) / spki (public). raw not supported in dev.
        const isPrivate = format === FMT.PKCS8;
        if (format === FMT.PKCS8) {
            const ko = nodeCrypto.createPrivateKey({ key, format: 'der', type: 'pkcs8' });
            return newEntry({ raw: null, keyObject: ko, alg, hash, isPrivate });
        }
        if (format === FMT.SPKI) {
            const ko = nodeCrypto.createPublicKey({ key, format: 'der', type: 'spki' });
            return newEntry({ raw: null, keyObject: ko, alg, hash, isPrivate });
        }
        return ERR_UNSUPPORTED;
    } catch {
        return ERR_INVALID_PARAMS;
    }
}

function aesAlgName(keyLen: number, mode: 'gcm' | 'cbc' | 'ctr'): string {
    const bits = keyLen === 16 ? 128 : keyLen === 32 ? 256 : 0;
    if (!bits) throw new Error('crypto: bad AES key length');
    return `aes-${String(bits)}-${mode}`;
}

function aesOp(
    cs: CryptoState, ref: MemoryRef, encrypt: boolean,
    handle: number, pp: number, pl: number, dp: number, dl: number,
): number {
    const e = cs.keys.get(handle);
    if (!e || !e.raw) throw new Error('crypto: invalid AES key handle');
    const pr = new ParamReader(readBytes(ref, pp, pl));
    const alg = pr.readI32();
    pr.readI32(); // hash (unused)
    const data = readBytes(ref, dp, dl);
    try {
        if (alg === ALG.AES_GCM) {
            const iv = pr.readBlob();
            const tagBits = pr.readI32();
            const aad = pr.readBlob();
            if (tagBits !== 0 && tagBits !== 128) return ERR_INVALID_PARAMS;
            if (encrypt) {
                const c = nodeCrypto.createCipheriv(
                    aesAlgName(e.raw.length, 'gcm'), e.raw, iv,
                ) as nodeCrypto.CipherGCM;
                if (aad.length) c.setAAD(aad);
                const ct = Buffer.concat([c.update(data), c.final()]);
                return stash(cs, Buffer.concat([ct, c.getAuthTag()]));
            }
            // Ciphertext must be at least the 16-byte tag; shorter input can
            // never authenticate.
            if (data.length < 16) return ERR_OPERATION_FAILED;
            const d = nodeCrypto.createDecipheriv(
                aesAlgName(e.raw.length, 'gcm'), e.raw, iv,
            ) as nodeCrypto.DecipherGCM;
            if (aad.length) d.setAAD(aad);
            const tag = data.subarray(data.length - 16);
            const ct = data.subarray(0, data.length - 16);
            d.setAuthTag(tag);
            return stash(cs, Buffer.concat([d.update(ct), d.final()]));
        }
        if (alg === ALG.AES_CBC) {
            const iv = pr.readBlob();
            const c = encrypt
                ? nodeCrypto.createCipheriv(aesAlgName(e.raw.length, 'cbc'), e.raw, iv)
                : nodeCrypto.createDecipheriv(aesAlgName(e.raw.length, 'cbc'), e.raw, iv);
            return stash(cs, Buffer.concat([c.update(data), c.final()]));
        }
        if (alg === ALG.AES_CTR) {
            const counter = pr.readBlob();
            const c = encrypt
                ? nodeCrypto.createCipheriv(aesAlgName(e.raw.length, 'ctr'), e.raw, counter)
                : nodeCrypto.createDecipheriv(aesAlgName(e.raw.length, 'ctr'), e.raw, counter);
            return stash(cs, Buffer.concat([c.update(data), c.final()]));
        }
        return ERR_UNSUPPORTED;
    } catch {
        return ERR_OPERATION_FAILED;
    }
}

function signOp(
    cs: CryptoState, ref: MemoryRef,
    handle: number, pp: number, pl: number, dp: number, dl: number,
): number {
    const e = cs.keys.get(handle);
    if (!e) throw new Error('crypto.sign: invalid handle');
    const pr = new ParamReader(readBytes(ref, pp, pl));
    const alg = pr.readI32();
    const hash = pr.readI32();
    const data = readBytes(ref, dp, dl);
    try {
        if (e.alg === ALG.HMAC && e.raw) {
            return stash(cs, nodeCrypto.createHmac(hashName(e.hash), e.raw).update(data).digest());
        }
        if (e.alg === ALG.ECDSA && e.keyObject) {
            const sig = nodeCrypto.sign(hashName(hash), data, {
                key: e.keyObject,
                dsaEncoding: 'ieee-p1363',
            });
            return stash(cs, sig);
        }
        if (e.alg === ALG.ED25519 && e.keyObject) {
            return stash(cs, nodeCrypto.sign(null, data, e.keyObject));
        }
        void alg;
        return ERR_UNSUPPORTED;
    } catch {
        return ERR_OPERATION_FAILED;
    }
}

function verifyOp(
    cs: CryptoState, ref: MemoryRef,
    handle: number, pp: number, pl: number, sp: number, sl: number, dp: number, dl: number,
): number {
    const e = cs.keys.get(handle);
    if (!e) throw new Error('crypto.verify: invalid handle');
    const pr = new ParamReader(readBytes(ref, pp, pl));
    pr.readI32(); // alg
    const hash = pr.readI32();
    const sig = readBytes(ref, sp, sl);
    const data = readBytes(ref, dp, dl);
    try {
        if (e.alg === ALG.HMAC && e.raw) {
            const mac = nodeCrypto.createHmac(hashName(e.hash), e.raw).update(data).digest();
            return mac.length === sig.length && nodeCrypto.timingSafeEqual(mac, sig) ? 1 : 0;
        }
        if (e.alg === ALG.ECDSA && e.keyObject) {
            const ok = nodeCrypto.verify(hashName(hash), data, {
                key: e.keyObject,
                dsaEncoding: 'ieee-p1363',
            }, sig);
            return ok ? 1 : 0;
        }
        if (e.alg === ALG.ED25519 && e.keyObject) {
            return nodeCrypto.verify(null, data, e.keyObject, sig) ? 1 : 0;
        }
        return ERR_UNSUPPORTED;
    } catch {
        return ERR_GENERIC;
    }
}

function deriveBitsOp(
    cs: CryptoState, ref: MemoryRef,
    handle: number, pp: number, pl: number, lengthBits: number,
): number {
    if (lengthBits < 0 || lengthBits % 8 !== 0) return ERR_INVALID_PARAMS;
    const outLen = lengthBits / 8;
    if (outLen > MAX_OUTPUT) return ERR_INVALID_PARAMS;
    const e = cs.keys.get(handle);
    if (!e) throw new Error('crypto.derive_bits: invalid handle');
    const pr = new ParamReader(readBytes(ref, pp, pl));
    const alg = pr.readI32();
    const hash = pr.readI32();
    try {
        if (alg === ALG.PBKDF2 && e.raw) {
            const iterations = pr.readU32();
            const salt = pr.readBlob();
            return stash(cs, nodeCrypto.pbkdf2Sync(e.raw, salt, iterations, outLen, hashName(hash)));
        }
        if (alg === ALG.HKDF && e.raw) {
            const salt = pr.readBlob();
            const info = pr.readBlob();
            const okm = nodeCrypto.hkdfSync(hashName(hash), e.raw, salt, info, outLen);
            return stash(cs, Buffer.from(okm));
        }
        if ((alg === ALG.ECDH || alg === ALG.X25519) && e.keyObject) {
            const peerHandle = pr.readI32();
            const peer = cs.keys.get(peerHandle);
            if (!peer || !peer.keyObject) throw new Error('crypto.derive_bits: invalid peer handle');
            const shared = nodeCrypto.diffieHellman({
                privateKey: e.keyObject,
                publicKey: peer.keyObject,
            });
            return stash(cs, Buffer.from(shared.subarray(0, Math.min(outLen, shared.length))));
        }
        return ERR_UNSUPPORTED;
    } catch {
        return ERR_OPERATION_FAILED;
    }
}
