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

import { argon2id } from 'hash-wasm';
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

/** The client auth surface, grouped for `Auth.register` / `Auth.login` use. */
export const Auth = { register, login, buildLoginMessage, LOGIN_CONTEXT } as const;
