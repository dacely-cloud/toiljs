// TwoFactor: a STATELESS email verification-code primitive (2FA / confirm /
// magic-code), available as a no-import global (the toilscript `--lib`
// mechanism, like `AuthService`, `EmailService`, `RateLimitService`). No
// database: the server stores nothing between mint and verify.
//
// How stateless verification works: `mint`/`issue` generates a random code,
// emails it to the recipient, and returns a signed TOKEN that commits to the
// code via HMAC over `(recipient, purpose, exp, code)` -- WITHOUT putting the
// code in the token (the code is only in the email). Hand the token to the
// client (a cookie or hidden field). On `verify(token, recipient, code)` the
// server recomputes the HMAC from the token's `(purpose, exp)` + the caller's
// `(recipient, code)` and constant-time compares. A valid `(token, code)` pair
// can only be produced by someone who BOTH received the email (knows the code)
// AND holds the token. The HMAC binds the recipient + purpose + expiry, so a
// token can't be replayed for another address, flow, or past its TTL.
//
// LIMITATION: this is integrity + expiry, NOT single-use. A valid code can be
// verified multiple times within its (short) TTL -- there is no server state to
// burn it. For true single-use, keep a per-recipient last-verified-at (a DB /
// the edge store) and reject codes at or before it, plus a short TTL.

import {
    CryptoKey,
    HmacImportParams,
    HmacParams,
    ALG_SHA_256,
    USAGE_SIGN,
    USAGE_VERIFY,
} from 'crypto';
import { DataWriter, DataReader } from 'data';

import { base64UrlEncode, base64UrlDecode, Time } from 'toiljs/server/runtime';

// HMAC key for the verification tokens. The SAME secret must be configured on
// every edge instance and kept out of any client bundle. The default is a loud
// DEV placeholder; a real deployment calls `TwoFactor.setSecret(...)` at startup
// (a build-time constant is consistent across instances).
// TODO(secret): move to a per-deployment host-config secret.
let __twofaSecret: Uint8Array = Uint8Array.wrap(
    String.UTF8.encode('toil-dev-insecure-2fa-secret-CHANGE-ME'),
);

/** Token format version (first byte of both the token and the signed message). */
const TWOFA_VERSION: u8 = 1;

function importHmac(key: Uint8Array): CryptoKey {
    return crypto.subtle.importKey(
        'raw',
        key,
        new HmacImportParams(ALG_SHA_256),
        false,
        USAGE_SIGN | USAGE_VERIFY,
    );
}

/** HMAC-SHA256 over `msg` with the configured secret. */
function hmac(msg: Uint8Array): Uint8Array {
    return crypto.subtle.sign(new HmacParams(), importHmac(__twofaSecret), msg);
}

/** Constant-time HMAC verify (the host's `crypto.verify` compares in constant time). */
function hmacVerify(mac: Uint8Array, msg: Uint8Array): bool {
    return crypto.subtle.verify(new HmacParams(), importHmac(__twofaSecret), mac, msg);
}

/**
 * The canonical signed message, a FIXED length-prefixed binary layout (no JSON,
 * so fields can't be confused): `u8 version | str recipient | str purpose |
 * u64 exp | str code`. The code is signed here but NEVER stored in the token.
 */
function canonicalMessage(recipient: string, purpose: string, exp: u64, code: string): Uint8Array {
    const w = new DataWriter();
    w.writeU8(TWOFA_VERSION);
    w.writeString(recipient);
    w.writeString(purpose);
    w.writeU64(exp);
    w.writeString(code);
    return w.toBytes();
}

/** The client token: `u8 version | str purpose | u64 exp | bytes mac` (base64url). */
function encodeToken(purpose: string, exp: u64, mac: Uint8Array): string {
    const w = new DataWriter();
    w.writeU8(TWOFA_VERSION);
    w.writeString(purpose);
    w.writeU64(exp);
    w.writeBytes(mac);
    return base64UrlEncode(w.toBytes());
}

/** A random numeric code of `digits` digits, from the CSPRNG. */
function randomCode(digits: i32): string {
    const buf = new Uint8Array(digits);
    crypto.getRandomValues(buf);
    let s = '';
    for (let i = 0; i < digits; i++) {
        // byte % 10: the tiny modulo bias is irrelevant for a short-lived code.
        s += (<i32>buf[i] % 10).toString();
    }
    return s;
}

function clampDigits(digits: i32): i32 {
    if (digits < 4) return 4;
    if (digits > 10) return 10;
    return digits;
}

/** A generated code + its token, for the bring-your-own-email path ({@link TwoFactor.issue}). */
export class TwoFactorIssue {
    code: string;
    token: string;
    constructor(code: string, token: string) {
        this.code = code;
        this.token = token;
    }
}

/** The result of {@link TwoFactor.send}: the token to hand the client + the email status. */
export class TwoFactorChallenge {
    token: string;
    status: EmailStatus;
    constructor(token: string, status: EmailStatus) {
        this.token = token;
        this.status = status;
    }
}

export namespace TwoFactor {
    /** Default code lifetime if none is given. Keep it short (stateless => not single-use). */
    export const DEFAULT_TTL_SECS: u64 = 600; // 10 minutes
    /** Default number of digits in a code. */
    export const DEFAULT_DIGITS: i32 = 6;

    /**
     * Configure the HMAC secret used to sign verification tokens. Call once at
     * startup from `main.ts`. Must be identical on every edge instance and kept
     * out of any client bundle.
     */
    export function setSecret(secret: Uint8Array): void {
        __twofaSecret = secret;
    }

    /**
     * Generate a code + token WITHOUT sending an email (bring your own email,
     * e.g. an `EmailTemplate`): mint the code yourself-friendly path. Email
     * `result.code` to `recipient` and hand `result.token` to the client.
     */
    export function issue(
        recipient: string,
        purpose: string,
        ttlSecs: u64 = DEFAULT_TTL_SECS,
        digits: i32 = DEFAULT_DIGITS,
    ): TwoFactorIssue {
        const code = randomCode(clampDigits(digits));
        const exp = Time.nowSeconds() + ttlSecs;
        const mac = hmac(canonicalMessage(recipient, purpose, exp, code));
        return new TwoFactorIssue(code, encodeToken(purpose, exp, mac));
    }

    /**
     * Issue a code and send it in a built-in email; returns the token + the send
     * {@link EmailStatus}. For a branded email, use {@link issue} + your own
     * `EmailTemplate`/`EmailService.send` instead.
     */
    export function send(
        recipient: string,
        purpose: string,
        ttlSecs: u64 = DEFAULT_TTL_SECS,
        digits: i32 = DEFAULT_DIGITS,
    ): TwoFactorChallenge {
        const issued = issue(recipient, purpose, ttlSecs, digits);
        const subject = 'Your verification code';
        const text =
            'Your verification code is ' +
            issued.code +
            '. It expires shortly. If you did not request it, ignore this email.';
        const html =
            '<table width="100%" style="font-family:Arial,sans-serif"><tbody><tr><td style="padding:24px">' +
            '<p style="color:#111827;font-size:15px;margin:0 0 8px">Your verification code is</p>' +
            '<p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#111827;margin:0">' +
            issued.code +
            '</p>' +
            '<p style="color:#9ca3af;font-size:12px;margin-top:20px">It expires shortly. If you did not request it, ignore this email.</p>' +
            '</td></tr></tbody></table>';
        const status = EmailService.send(recipient, subject, text, purpose, html);
        return new TwoFactorChallenge(issued.token, status);
    }

    /**
     * Verify a `(token, code)` pair for `recipient`. Stateless: recomputes the
     * HMAC from the token's `(purpose, exp)` + the supplied `(recipient, code)`
     * and constant-time compares, after checking the version and expiry. Returns
     * `true` only for a code that was issued for this recipient and has not
     * expired. NOT single-use within the TTL (see the file header).
     */
    export function verify(token: string, recipient: string, code: string): bool {
        const raw = base64UrlDecode(token);
        if (raw == null) return false;

        const r = new DataReader(raw);
        if (r.readU8() != TWOFA_VERSION) return false;
        const purpose = r.readString();
        const exp = r.readU64();
        const mac = r.readBytes();
        if (!r.ok) return false; // truncated / malformed token

        if (Time.nowSeconds() >= exp) return false; // expired

        return hmacVerify(mac, canonicalMessage(recipient, purpose, exp, code));
    }
}
