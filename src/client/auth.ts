/**
 * Client half of the post-quantum auth primitive (browser).
 *
 * The password never leaves this module. It is stretched with Argon2id into a
 * 32-byte seed, which deterministically expands into an ML-DSA-44 keypair
 * (FIPS 204). Only the 1312-byte PUBLIC key is ever sent; the secret key and
 * the seed are zeroized the instant signing is done. There is no recovery: the
 * password IS the key.
 *
 * Wire encoding is deterministic binary (`DataWriter`/`DataReader`), never
 * JSON, byte-identical to the server's `AuthService.buildLoginMessage`.
 */

import { argon2id, sha256 } from 'hash-wasm';
import { ml_dsa44 } from '@btc-vision/post-quantum/ml-dsa.js';

import { DataReader, DataWriter } from 'toiljs/io';

/** FIPS 204 signing context (domain separator). Byte-identical to the server. */
export const LOGIN_CONTEXT = 'qauth:login:v1';

export const PUBLIC_KEY_LEN = 1312;
export const SECRET_KEY_LEN = 2560;
export const SIGNATURE_LEN = 2420;
export const SEED_LEN = 32;

/** Argon2id parameters, pinned PER ACCOUNT and echoed by the server. The client
 *  derives against whatever it is handed -- never hardcoded -- so a future
 *  parameter bump just works. They are part of the credential. */
export interface KdfParams {
    /** `m`: memory in kibibytes (>= 256 MiB = 262144). */
    readonly memKiB: number;
    /** `t`: iterations (>= 3). */
    readonly iterations: number;
    /** `p`: degree of parallelism. */
    readonly parallelism: number;
    /** per-account salt (16 bytes, server-issued). */
    readonly salt: Uint8Array;
}

/** A server login challenge. */
export interface Challenge {
    readonly cid: Uint8Array;
    readonly aud: string;
    readonly kdf: KdfParams;
    readonly nonce: Uint8Array;
    readonly iat: bigint;
    readonly exp: bigint;
}

/** Overwrite a secret buffer with random bytes, then zero. Best-effort: JS GC
 *  cannot scrub copies, so we never store or close over secrets beyond one call. */
function wipe(buf: Uint8Array): void {
    crypto.getRandomValues(buf as unknown as Uint8Array<ArrayBuffer>);
    buf.fill(0);
}

/** Argon2id(NFKC(password), salt; m,t,p, len=32) -> 32-byte ML-DSA seed. */
async function deriveSeed(password: string, kdf: KdfParams): Promise<Uint8Array> {
    return argon2id({
        password: new TextEncoder().encode(password.normalize('NFKC')),
        salt: kdf.salt,
        iterations: kdf.iterations,
        parallelism: kdf.parallelism,
        memorySize: kdf.memKiB,
        hashLength: SEED_LEN,
        outputType: 'binary',
    });
}

/** The canonical login message `M`, fixed binary layout (see the server's
 *  `AuthService.buildLoginMessage`). Both ends MUST produce identical bytes. */
export function buildLoginMessage(
    sub: string,
    aud: string,
    cid: Uint8Array,
    nonce: Uint8Array,
    iat: bigint,
    exp: bigint,
): Uint8Array {
    return new DataWriter()
        .writeU8(1)
        .writeString(sub)
        .writeString(aud)
        .writeBytes(cid)
        .writeBytes(nonce)
        .writeU64(iat)
        .writeU64(exp)
        .toBytes();
}

// ---- wire codecs (the example `Auth` @rest controller mirrors these) -------

function decodeKdf(r: DataReader): KdfParams {
    return {
        memKiB: r.readU32(),
        iterations: r.readU32(),
        parallelism: r.readU32(),
        salt: r.readBytes(),
    };
}

function decodeChallenge(r: DataReader): Challenge {
    const cid = r.readBytes();
    const aud = r.readString();
    const kdf = decodeKdf(r);
    const nonce = r.readBytes();
    const iat = r.readU64();
    const exp = r.readU64();
    return { cid, aud, kdf, nonce, iat, exp };
}

async function postBinary(baseUrl: string, path: string, body: Uint8Array): Promise<DataReader> {
    const res = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as BodyInit,
        credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('auth: request failed');
    return new DataReader(new Uint8Array(await res.arrayBuffer()));
}

export interface AuthOptions {
    /** Endpoint prefix the server mounts the auth controller under. */
    readonly baseUrl?: string;
}

/**
 * Register a new account: the server issues a salt + KDF params, the client
 * derives the keypair and submits ONLY the public key. Throws on failure.
 */
export async function register(username: string, password: string, opts: AuthOptions = {}): Promise<void> {
    const baseUrl = opts.baseUrl ?? '/auth';

    // 1. Ask the server for a salt + params (it also confirms the name is free).
    const start = await postBinary(baseUrl, '/register/start', new DataWriter().writeString(username).toBytes());
    const status = start.readU8();
    if (status !== 0) throw new Error('auth: registration unavailable');
    const kdf = decodeKdf(start);

    // 2. Derive, keep only the public key, wipe the secret + seed immediately.
    const seed = await deriveSeed(password, kdf);
    let publicKey: Uint8Array;
    try {
        const kp = ml_dsa44.keygen(seed);
        publicKey = kp.publicKey;
        wipe(kp.secretKey);
    } finally {
        wipe(seed);
    }
    if (publicKey.length !== PUBLIC_KEY_LEN) throw new Error('auth: bad public key length');

    // 3. Submit the public key.
    const finish = await postBinary(
        baseUrl,
        '/register/finish',
        new DataWriter().writeString(username).writeBytes(publicKey).toBytes(),
    );
    if (finish.readU8() !== 0) throw new Error('auth: registration rejected');
}

/**
 * Log in: fetch a challenge, re-derive the keypair, sign the rebuilt message
 * under the login context, and submit only `{cid, signature}`. The secret key
 * and seed are wiped the instant the single sign completes. Returns the opaque
 * session token the server mints (and any session cookie it sets). Throws on
 * failure with one generic message.
 */
export async function login(username: string, password: string, opts: AuthOptions = {}): Promise<Uint8Array> {
    const baseUrl = opts.baseUrl ?? '/auth';

    // 1. Challenge (the server returns one even for unknown users -> no oracle).
    const ch = decodeChallenge(
        await postBinary(baseUrl, '/login/start', new DataWriter().writeString(username).toBytes()),
    );

    // Client-side fast-fail only; the server re-checks expiry authoritatively.
    if (BigInt(Math.floor(Date.now() / 1000)) >= ch.exp) throw new Error('auth: challenge expired');

    // 2. Build the exact message, derive, sign once, wipe.
    const message = buildLoginMessage(username, ch.aud, ch.cid, ch.nonce, ch.iat, ch.exp);
    const seed = await deriveSeed(password, ch.kdf);
    let signature: Uint8Array;
    try {
        const kp = ml_dsa44.keygen(seed);
        try {
            signature = ml_dsa44.sign(message, kp.secretKey, { context: new TextEncoder().encode(LOGIN_CONTEXT) });
        } finally {
            wipe(kp.secretKey);
        }
    } finally {
        wipe(seed);
    }
    if (signature.length !== SIGNATURE_LEN) throw new Error('auth: bad signature length');

    // 3. Submit {cid, signature}; the server consumes the challenge atomically,
    //    rebuilds the message from its own stored values, and verifies.
    const res = await postBinary(
        baseUrl,
        '/login/finish',
        new DataWriter().writeBytes(ch.cid).writeBytes(signature).toBytes(),
    );
    if (res.readU8() !== 0) throw new Error('auth: login failed');
    return res.readBytes(); // session token
}

/** Lowercase hex of `bytes`. */
function toHex(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
}

/** The signed identity proof produced by {@link proveIdentity}. */
export interface IdentityProof {
    /** The wire envelope to POST to `/pq/verify`: `str(sub) str(token)
     *  bytes(publicKey) bytes(signature)`, where `token` is the edge's
     *  HMAC-signed challenge. The server re-opens the token, rebuilds the login
     *  message from the values inside it, and `AuthService.verifyLogin`s it. */
    readonly envelope: Uint8Array;
    /** First bytes of the 1312-byte ML-DSA-44 public key, for display. */
    readonly publicKeyHex: string;
    /** First bytes of the SERVER-issued nonce that was signed, for display. */
    readonly nonceHex: string;
    /** Signature length (always 2420 for ML-DSA-44), for display. */
    readonly signatureLen: number;
    /** Argon2id wall-clock spent deriving the keypair, ms (for display). */
    readonly deriveMs: number;
}

/** Deterministic 16-byte Argon2id salt for the demo, so the same
 *  username + password always maps to the same identity (keypair).
 *  Uses hash-wasm's SHA-256 (pure WebAssembly), not `crypto.subtle`, so it
 *  works in an insecure context (plain HTTP), where `crypto.subtle` is
 *  undefined. */
async function demoSalt(username: string): Promise<Uint8Array> {
    const hex = await sha256('pq-demo|' + username);
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/**
 * DEMO helper: run the full post-quantum challenge-response in the browser.
 * Fetches a SERVER-issued challenge (`GET {baseUrl}/challenge`), stretches the
 * password with Argon2id into an ML-DSA-44 keypair, signs the login message
 * built from the SERVER's nonce/cid/iat/exp, and returns the wire envelope the
 * edge verifies (`AuthService.verifyLogin`). The secret key and seed are wiped
 * before returning; only the public key + signature leave the tab.
 *
 * The nonce is server-chosen and tamper-proof (the challenge token is
 * HMAC-signed by the edge), so a client cannot pre-sign or substitute its own.
 * It is still NOT the full production login -- there is no single-use consume, so
 * within the challenge TTL a captured proof could be replayed; that needs an
 * atomic store (see {@link login} and server/routes/Auth.ts). Demo-light
 * Argon2id params (16 MiB / 2 passes) keep it responsive in a tab; a real
 * deployment uses >= 256 MiB.
 */
export async function proveIdentity(
    username: string,
    password: string,
    opts: { baseUrl?: string } = {},
): Promise<IdentityProof> {
    const baseUrl = opts.baseUrl ?? '/pq';

    // 1. Server-issued challenge: aud, cid, nonce, iat, exp, and the signed token.
    const cres = await fetch(baseUrl + '/challenge', { credentials: 'same-origin' });
    if (!cres.ok) throw new Error('pq: challenge request failed');
    const cr = new DataReader(new Uint8Array(await cres.arrayBuffer()));
    const aud = cr.readString();
    const cid = cr.readBytes();
    const nonce = cr.readBytes();
    const iat = cr.readU64();
    const exp = cr.readU64();
    const token = cr.readString();

    // 2. Derive the keypair and sign the message built from the SERVER's values.
    const salt = await demoSalt(username);
    const t0 = Date.now();
    const seed = await argon2id({
        password: new TextEncoder().encode(password.normalize('NFKC')),
        salt,
        iterations: 2,
        parallelism: 1,
        memorySize: 16 * 1024, // 16 MiB: demo-light, responsive in a tab
        hashLength: SEED_LEN,
        outputType: 'binary',
    });
    const deriveMs = Date.now() - t0;

    const message = buildLoginMessage(username, aud, cid, nonce, iat, exp);
    let publicKey: Uint8Array;
    let signature: Uint8Array;
    try {
        const kp = ml_dsa44.keygen(seed);
        publicKey = kp.publicKey;
        try {
            signature = ml_dsa44.sign(message, kp.secretKey, {
                context: new TextEncoder().encode(LOGIN_CONTEXT),
            });
        } finally {
            wipe(kp.secretKey);
        }
    } finally {
        wipe(seed);
    }

    // 3. Envelope: sub + the server's token + the public key + the signature.
    const envelope = new DataWriter()
        .writeString(username)
        .writeString(token)
        .writeBytes(publicKey)
        .writeBytes(signature)
        .toBytes();

    return {
        envelope,
        publicKeyHex: toHex(publicKey.slice(0, 16)),
        nonceHex: toHex(nonce.slice(0, 16)),
        signatureLen: signature.length,
        deriveMs,
    };
}

/** The client auth surface, grouped for `Auth.register` / `Auth.login` use. */
export const Auth = { register, login, proveIdentity, buildLoginMessage, LOGIN_CONTEXT } as const;
