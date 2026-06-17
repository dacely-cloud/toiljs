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

import { argon2id, sha256, createSHA256 } from 'hash-wasm';
import { ml_dsa44 } from '@dacely/noble-post-quantum/ml-dsa.js';
import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem.js';
import { ristretto255_oprf } from '@noble/curves/ed25519.js';

import { DataReader, DataWriter } from 'toiljs/io';

/** FIPS 204 signing context (domain separator). Byte-identical to the server. */
export const LOGIN_CONTEXT = 'qauth:login:v1';
/** Registration proof-of-possession context (binds a sig to "register"). */
export const REGISTER_CONTEXT = 'qauth:register:v1';
/** Domain separator for the server's mutual-auth confirmation tag. */
export const SERVER_CONFIRM_LABEL = 'toil-server-confirm-v1';

/** ML-KEM-768 sizes (FIPS 203). */
export const KEM_PUBLIC_KEY_LEN = 1184;
export const KEM_CIPHERTEXT_LEN = 1088;
export const SHARED_SECRET_LEN = 32;

/** Lowercase-hex -> bytes. */
function fromHex(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/**
 * The server's PINNED static ML-KEM-768 public key. The client encapsulates to
 * it; only the genuine server (holder of the matching secret key) can
 * decapsulate, so a valid confirmation tag authenticates the server. This is
 * the demo dev key; a real deployment pins its own (and rotates it).
 */
export const SERVER_KEM_PUBLIC_KEY = fromHex('29d765e8083182891302569b3712a856e564fdd484b0706b0c68568d5ab7edc742cf74459d64595455a60f267973aa55e43c5be61925a3822eafcca445e36dc4655636e31e6fc9bec338b253f94290008ef7f40dbddb49c15c690f6755a23a1b3c85cfd5207e71a607086a6fc6d74a05080f43276901a19cafdb8de7771d58ea07f0f1056b905127b22223d08e75173199f13ab13c5dcd3b51ac784f84e520484a262b845a897c41cf27324ab6ba545c78c9ccab361051e0bba53498af26240fa0d566d1572684f4b42e253e6d052c848650915063c35641e1121ef8d9cfd17b667b351103c56d195007c9376d0c08aa268396814490eab4c364175a94533267a1933862cc4c33bcf0a13d1fa2b9d6c5082eeca1480672f2526cbe013beff14dc908a386e0b633c8761023cbed760deac6709bc328d865ac82e12307b673d96711dbb27a4d939230d25b53d594169a318be0200fa33550e9418e2a3b30e9719edc09d5fc4306f1abfd021eab14637a8a72c5931d25dc9b56db0e6ab677522b10f25307dbb804a6774ce05b87b0976a4b227bfe6caf20a79e64004fbd27b1eea018b3ab8ffa629f2dc87f19278f95168e94e44660a3370c537795678eb2f056260609769740583b51b291862927a1938737c6a37f40b78f00671cccbcb88ac3427b37915ed58782998f84051647707d48995472baad3f64a7cca54e1c0734db08751c614a34f28b84f2c1b5a6817355ab61957c486b7acffbc092bc8a7b46387f33b53ed372f7168d31a71cd008539928b0cdf91e835aa97f6a2be6d327b87a6ae478701d75a59a25179cb14997bb2552853014724170a1c49b82c2bcebc3279024e1fa44c53c7afdc43f0bd22116490f3b74c90e7296be58b9a91168f2fa0c3d378a3bcac959f357825c9976a8c9ee944f29b45e96d7345d9b478431a20cf1c5d3a3227c717fd204619777636c0cb140db5c50d2a3302334461030bee34e4eb1a6f02b733f9ccda4290fa168bc039568373241542728d00030d1f251e83737cb215adbdc1de75978675a0cd0d75b12748abdda7a9852629c63697d145af2c69854b06e03f37c4b064e4c9a4c03f2ad4d081e70180e9547247921918118086b62b4f7727f46b24e3e79ba3f28209f32b5102035bf935856232f83642268c0292ec6bf8e9462382163d30a20b4bcb7b4439310ec9d0a148193907fc07697342967cf1a16c6b3c71558951fa915400736cf699262b54b723abb2ecc27b74b68ee494287595ef818388adb49e883c67bfa5c226c0eef037a0851a29d34675912c1ea1068310b6dfcd017c809c8fbfc2c3ae78dfef07299960eeefba182662a90fa422c1790f356a2ea909012b15623a9b9e450a282cb530589a68368b3583159d9010ac3e52cc974753c342e58279516339dfb691df94b13a223ad97eb6a09c21dafe6304a3642d6d2067b5238497661fe88ad1227ca3557be2a576b6e17c5a7f997ea07929e76407e376aba74c44cd8504804776f39bbb8327624188a63501e83b404d9438cade0b11dc3ac61856447fb072b91761c228878f01b2eb6b4b21ba664c2c75882431603b25a449ffeb8410b910558581777562aa9b2181fd9c04713ad9326462d3e842121c4997f9aa932417c67851625816de66e0d65637434629f39');

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

/** Overwrite a secret buffer with random bytes, then zero. Best-effort: JS GC
 *  cannot scrub copies, so we never store or close over secrets beyond one call. */
function wipe(buf: Uint8Array): void {
    crypto.getRandomValues(buf as unknown as Uint8Array<ArrayBuffer>);
    buf.fill(0);
}

/** Argon2id(oprfOutput, salt; m,t,p, len=32) -> 32-byte ML-DSA seed. The KDF
 *  input is the OPRF output (the keyed salt), NOT the raw password: the password
 *  is first run through the server-keyed OPRF, so a server breach yields no
 *  precomputable salt. */
async function deriveSeed(oprfOutput: Uint8Array, kdf: KdfParams): Promise<Uint8Array> {
    return argon2id({
        password: oprfOutput,
        salt: kdf.salt,
        iterations: kdf.iterations,
        parallelism: kdf.parallelism,
        memorySize: kdf.memKiB,
        hashLength: SEED_LEN,
        outputType: 'binary',
    });
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** SHA-256 over `data` -> 32 raw bytes. Uses hash-wasm (pure WASM), so it works
 *  in an insecure context (plain HTTP) where `crypto.subtle` is undefined. */
async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
    const h = await createSHA256();
    h.init();
    h.update(data);
    return h.digest('binary') as unknown as Uint8Array;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

/** Length-checked constant-time-ish equality (no early-exit on content). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
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

/** Login message `M` v2: the v1 fields plus the ML-KEM ciphertext, so the
 *  ML-DSA signature binds the key encapsulation. Byte-identical to the server's
 *  `AuthService.buildLoginMessageV2`. */
export function buildLoginMessageV2(
    sub: string,
    aud: string,
    cid: Uint8Array,
    nonce: Uint8Array,
    iat: bigint,
    exp: bigint,
    ciphertext: Uint8Array,
): Uint8Array {
    return new DataWriter()
        .writeU8(2)
        .writeString(sub)
        .writeString(aud)
        .writeBytes(cid)
        .writeBytes(nonce)
        .writeU64(iat)
        .writeU64(exp)
        .writeBytes(ciphertext)
        .toBytes();
}

/** Registration proof-of-possession message: `u8(1) str(username) bytes(pk)`,
 *  signed under {@link REGISTER_CONTEXT}. Byte-identical to the server's
 *  `buildRegisterMessage`. */
export function buildRegisterMessage(username: string, publicKey: Uint8Array): Uint8Array {
    return new DataWriter().writeU8(1).writeString(username).writeBytes(publicKey).toBytes();
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
 * Register a new account (OPAQUE-style). The password never leaves the browser:
 * it is blinded and run through the server-keyed OPRF, the OPRF output is
 * stretched with Argon2id into an ML-DSA-44 keypair, and ONLY the public key
 * (plus a proof-of-possession signature) is submitted. Throws on failure.
 */
export async function register(username: string, password: string, opts: AuthOptions = {}): Promise<void> {
    const baseUrl = opts.baseUrl ?? '/auth';
    const oprf = ristretto255_oprf.oprf;
    const pw = utf8(password.normalize('NFKC'));

    // 1. Blind the password and start registration: the server confirms the name
    //    is free, issues salt + KDF params, and OPRF-evaluates the blinded input.
    const { blind, blinded } = oprf.blind(pw);
    const start = await postBinary(
        baseUrl,
        '/register/start',
        new DataWriter().writeString(username).writeBytes(blinded).toBytes(),
    );
    const status = start.readU8();
    if (status !== 0) throw new Error('auth: registration unavailable');
    const kdf = decodeKdf(start);
    const evaluated = start.readBytes();

    // 2. Finalize the OPRF -> keyed salt -> seed -> keypair. Keep only the public
    //    key + a PoP signature; wipe the secret key and seed immediately.
    const oprfOutput = oprf.finalize(pw, blind, evaluated);
    const seed = await deriveSeed(oprfOutput, kdf);
    let publicKey: Uint8Array;
    let regProof: Uint8Array;
    try {
        const kp = ml_dsa44.keygen(seed);
        publicKey = kp.publicKey;
        try {
            regProof = ml_dsa44.sign(buildRegisterMessage(username, publicKey), kp.secretKey, {
                context: utf8(REGISTER_CONTEXT),
            });
        } finally {
            wipe(kp.secretKey);
        }
    } finally {
        wipe(seed);
    }
    if (publicKey.length !== PUBLIC_KEY_LEN) throw new Error('auth: bad public key length');

    // 3. Submit the public key + proof-of-possession.
    const finish = await postBinary(
        baseUrl,
        '/register/finish',
        new DataWriter().writeString(username).writeBytes(publicKey).writeBytes(regProof).toBytes(),
    );
    if (finish.readU8() !== 0) throw new Error('auth: registration rejected');
}

/**
 * Log in (OPAQUE-style, with ML-KEM mutual auth). Steps:
 *   1. Blind the password; `login/start` returns the challenge + the OPRF
 *      evaluation (a fully-formed response even for unknown users -> no oracle).
 *   2. Finalize the OPRF -> keyed salt -> seed -> ML-DSA keypair.
 *   3. Encapsulate a shared secret to the PINNED server ML-KEM public key, build
 *      the v2 message (which binds the ciphertext), and sign it once.
 *   4. Submit `{cid, ct, signature}`; the server consumes the challenge, verifies
 *      the signature, decapsulates, and returns a confirmation tag.
 *   5. Verify that tag against our own shared secret -> the server proved it
 *      holds the KEM secret key (mutual authentication).
 * The secret key, seed, and shared secret are wiped as soon as they are used.
 * Returns the opaque session token. Throws (one generic message) on any failure.
 */
export async function login(username: string, password: string, opts: AuthOptions = {}): Promise<Uint8Array> {
    const baseUrl = opts.baseUrl ?? '/auth';
    const oprf = ristretto255_oprf.oprf;
    const pw = utf8(password.normalize('NFKC'));

    // 1. Blinded login/start.
    const { blind, blinded } = oprf.blind(pw);
    const r = await postBinary(
        baseUrl,
        '/login/start',
        new DataWriter().writeString(username).writeBytes(blinded).toBytes(),
    );
    const cid = r.readBytes();
    const aud = r.readString();
    const kdf = decodeKdf(r);
    const nonce = r.readBytes();
    const iat = r.readU64();
    const exp = r.readU64();
    const evaluated = r.readBytes();
    // Client-side fast-fail only; the server re-checks expiry authoritatively.
    if (BigInt(Math.floor(Date.now() / 1000)) >= exp) throw new Error('auth: challenge expired');

    // 2. OPRF -> keyed salt -> seed.
    const oprfOutput = oprf.finalize(pw, blind, evaluated);
    const seed = await deriveSeed(oprfOutput, kdf);

    // 3. Encapsulate to the pinned server KEM key, build + sign the v2 message.
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(SERVER_KEM_PUBLIC_KEY);
    const message = buildLoginMessageV2(username, aud, cid, nonce, iat, exp, cipherText);
    let signature: Uint8Array;
    try {
        const kp = ml_dsa44.keygen(seed);
        try {
            signature = ml_dsa44.sign(message, kp.secretKey, { context: utf8(LOGIN_CONTEXT) });
        } finally {
            wipe(kp.secretKey);
        }
    } finally {
        wipe(seed);
    }
    if (signature.length !== SIGNATURE_LEN) throw new Error('auth: bad signature length');

    // 4. Submit {cid, ct, signature}.
    const res = await postBinary(
        baseUrl,
        '/login/finish',
        new DataWriter().writeBytes(cid).writeBytes(cipherText).writeBytes(signature).toBytes(),
    );
    if (res.readU8() !== 0) {
        wipe(sharedSecret);
        throw new Error('auth: login failed');
    }
    const session = res.readBytes();
    const serverConfirm = res.readBytes();

    // 5. Mutual auth: only a server that decapsulated correctly can produce
    //    SHA-256(label || sharedSecret || sha256(M)). Verify before trusting.
    const transcriptHash = await sha256Bytes(message);
    const expected = await sha256Bytes(
        concatBytes(utf8(SERVER_CONFIRM_LABEL), sharedSecret, transcriptHash),
    );
    wipe(sharedSecret);
    if (!bytesEqual(expected, serverConfirm)) throw new Error('auth: server authentication failed');

    return session; // session token
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
