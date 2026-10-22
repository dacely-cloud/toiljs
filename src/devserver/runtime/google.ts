/** Google keys are shared across fresh Wasm instances; no tokeninfo/userinfo calls. */
import { createPublicKey, verify, type KeyObject, type webcrypto } from 'node:crypto';
import type { MemoryRef } from './host.js';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let keys = new Map<string, KeyObject>();
let expires = 0;
let refreshAfter = 0;
let needsRefresh = false;
let pending: Promise<void> | undefined;

/** Single-flight refresh, including unknown-kid cooldown and bounded failed-fetch retry. */
export async function prepareGoogleKeys(): Promise<void> {
    if (pending) return pending;
    if ((!needsRefresh && Date.now() < expires) || Date.now() < refreshAfter) return;
    refreshAfter = Date.now() + 30_000;
    pending = (async () => {
        const response = await fetch(CERTS_URL, {
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
        });
        if (!response.ok) throw new Error('Google keys unavailable');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Google keys unavailable');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 65536) throw new Error('Google keys too large');
                chunks.push(value);
            }
        } finally {
            await reader.cancel();
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            keys?: (webcrypto.JsonWebKey & { kid?: string; use?: string })[];
        };
        if (!Array.isArray(body.keys) || body.keys.length > 16)
            throw new Error('Invalid Google keys');
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys) {
            if (
                jwk.kty !== 'RSA' ||
                jwk.alg !== 'RS256' ||
                jwk.use !== 'sig' ||
                typeof jwk.kid !== 'string' ||
                jwk.e !== 'AQAB'
            )
                continue;
            const key = createPublicKey({ key: jwk, format: 'jwk' });
            const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
            if (bits < 2048 || bits > 4096) continue;
            next.set(jwk.kid, key);
        }
        if (!next.size) throw new Error('Invalid Google keys');
        keys = next;
        needsRefresh = false;
        const ttl = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '');
        expires = Date.now() + Math.min(Number(ttl?.[1] ?? 300), 21600) * 1000;
    })().finally(() => {
        pending = undefined;
    });
    return pending;
}

export function verifyGoogleToken(
    token: string,
    audience: string,
    nonce: string,
): { sub: string; email: string; issuedAt: number; emailAuthoritative: boolean } | null {
    if (
        token.length > 16384 ||
        !audience ||
        audience.length > 256 ||
        !nonce ||
        nonce.length > 128 ||
        Date.now() >= expires
    )
        return null;
    try {
        const parts = token.split('.');
        if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Record<
            string,
            unknown
        >;
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined)
            return null;
        const key = keys.get(header.kid);
        // Rotation can refresh once per cooldown, never one outbound request per random kid.
        if (!key) {
            needsRefresh = true;
            return null;
        }
        if (
            !verify(
                'RSA-SHA256',
                Buffer.from(parts[0] + '.' + parts[1]),
                key,
                Buffer.from(parts[2], 'base64url'),
            )
        )
            return null;
        const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<
            string,
            unknown
        >;
        const now = Math.floor(Date.now() / 1000);
        if (
            (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') ||
            c.aud !== audience ||
            (c.azp !== undefined && c.azp !== audience) ||
            c.nonce !== nonce ||
            c.email_verified !== true ||
            typeof c.exp !== 'number' ||
            !Number.isSafeInteger(c.exp) ||
            c.exp <= now ||
            (c.nbf !== undefined &&
                (typeof c.nbf !== 'number' || !Number.isSafeInteger(c.nbf) || c.nbf > now + 30)) ||
            typeof c.iat !== 'number' ||
            !Number.isSafeInteger(c.iat) ||
            c.iat > now + 30 ||
            c.iat < now - 600 ||
            typeof c.sub !== 'string' ||
            !/^[A-Za-z0-9_-]{1,255}$/.test(c.sub) ||
            typeof c.email !== 'string' ||
            c.email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)
        )
            return null;
        const email = c.email.toLowerCase();
        return {
            sub: c.sub, email, issuedAt: c.iat,
            emailAuthoritative: email.endsWith('@gmail.com') || (typeof c.hd === 'string' && c.hd.length > 0),
        };
    } catch {
        return null;
    }
}

export function googleVerifyImport(
    ref: MemoryRef,
    tp: number,
    tl: number,
    ap: number,
    al: number,
    np: number,
    nl: number,
    out: number,
    cap: number,
): number {
    const memory = ref.memory;
    if (
        !memory ||
        tl < 1 ||
        tl > 16384 ||
        al < 1 ||
        al > 256 ||
        nl < 1 ||
        nl > 128 ||
        cap < 0 ||
        cap > 1024
    )
        return -1;
    const bytes = Buffer.from(memory.buffer);
    for (const [ptr, len] of [
        [tp, tl],
        [ap, al],
        [np, nl],
        [out, cap],
    ])
        if (ptr < 0 || ptr > bytes.length || len > bytes.length - ptr) return -1;
    const c = verifyGoogleToken(
        bytes.toString('utf8', tp, tp + tl),
        bytes.toString('utf8', ap, ap + al),
        bytes.toString('utf8', np, np + nl),
    );
    if (!c) return -1;
    const sub = Buffer.from(c.sub),
        email = Buffer.from(c.email);
    const len = 17 + sub.length + email.length;
    if (len > cap) return -1;
    bytes.writeUInt32LE(sub.length, out);
    bytes.set(sub, out + 4);
    bytes.writeUInt32LE(email.length, out + 4 + sub.length);
    bytes.set(email, out + 8 + sub.length);
    bytes.writeBigUInt64LE(BigInt(c.issuedAt), out + 8 + sub.length + email.length);
    bytes[out + 16 + sub.length + email.length] = c.emailAuthoritative ? 1 : 0;
    return len;
}
