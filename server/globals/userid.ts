/**
 * `ToilUserId` — the stable, tenant-scoped 256-bit user identity.
 *
 * Derived once as `sha256(mldsaPublicKey || identifier || domain)`, so the SAME user (same ML-DSA login
 * public key + the same email/username) on the SAME tenant domain always maps to the SAME id — independent
 * of session, cookie, or device. It is opaque and one-way (a hash), so it is safe to store, log, or use as
 * a stable database key without leaking the underlying key or address.
 *
 * Backed by four 64-bit words (a 256-bit value), NOT a byte array, so equality is four word compares with
 * early-out — no allocation, no byte loop. `==` / `!=` are overloaded to value equality, and `equals()` is
 * the explicit form. (`===` in AssemblyScript is reference identity and is NOT overloadable; use `==` for
 * value equality.)
 *
 * A global (no import), like `crypto` / `AuthService`. `AuthService` mints the current user's id from the
 * login key + identifier + the request's tenant domain, so `@auth` handlers can key on a stable user.
 */
export class ToilUserId {
    constructor(
        public w0: u64 = 0,
        public w1: u64 = 0,
        public w2: u64 = 0,
        public w3: u64 = 0,
    ) {}

    /**
     * Derive the id from the user's ML-DSA public key, their identifier (email or username), and the
     * tenant `domain` (the site on dacely). Deterministic: identical inputs → identical id. The three
     * inputs are concatenated in order and SHA-256'd; length-framing is unnecessary because the ML-DSA
     * public key is a FIXED length (1312 bytes for ML-DSA-44), so the boundary before `identifier` is
     * unambiguous, and `domain` is the trusted tail supplied by the host, not the user.
     */
    static derive(mldsaPublicKey: Uint8Array, identifier: string, domain: string): ToilUserId {
        const id = Uint8Array.wrap(String.UTF8.encode(identifier));
        const dom = Uint8Array.wrap(String.UTF8.encode(domain));
        const buf = new Uint8Array(mldsaPublicKey.length + id.length + dom.length);
        buf.set(mldsaPublicKey, 0);
        buf.set(id, mldsaPublicKey.length);
        buf.set(dom, mldsaPublicKey.length + id.length);
        return ToilUserId.fromBytes(crypto.sha256(buf));
    }

    /** Build from a 32-byte digest. Bytes past 32 are ignored; a shorter array zero-pads the tail. */
    static fromBytes(b: Uint8Array): ToilUserId {
        if (b.length >= 32) {
            const p = b.dataStart;
            return new ToilUserId(load<u64>(p, 0), load<u64>(p, 8), load<u64>(p, 16), load<u64>(p, 24));
        }
        const tmp = new Uint8Array(32);
        tmp.set(b, 0);
        const p = tmp.dataStart;
        return new ToilUserId(load<u64>(p, 0), load<u64>(p, 8), load<u64>(p, 16), load<u64>(p, 24));
    }

    /** The 32-byte identity (the original SHA-256 digest bytes; wasm is little-endian, so this round-trips). */
    toBytes(): Uint8Array {
        const out = new Uint8Array(32);
        const p = out.dataStart;
        store<u64>(p, this.w0, 0);
        store<u64>(p, this.w1, 8);
        store<u64>(p, this.w2, 16);
        store<u64>(p, this.w3, 24);
        return out;
    }

    /** Lowercase hex, 64 chars. */
    toHex(): string {
        const b = this.toBytes();
        const HEX = '0123456789abcdef';
        let s = '';
        for (let i = 0; i < 32; i++) {
            const v = <i32>b[i];
            s += HEX.charAt(v >> 4);
            s += HEX.charAt(v & 0xf);
        }
        return s;
    }

    /** True when unset (the all-zero id, e.g. an absent / anonymous user). */
    isZero(): bool {
        return (this.w0 | this.w1 | this.w2 | this.w3) == 0;
    }

    /** Value equality: four u64 compares, short-circuiting. O(1), no allocation. */
    @inline
    equals(other: ToilUserId): bool {
        return (
            this.w0 == other.w0 &&
            this.w1 == other.w1 &&
            this.w2 == other.w2 &&
            this.w3 == other.w3
        );
    }

    /** `a == b` value equality (overloaded). */
    @operator('==')
    @inline
    eq(other: ToilUserId): bool {
        return this.equals(other);
    }

    /** `a != b` value inequality (overloaded). */
    @operator('!=')
    @inline
    ne(other: ToilUserId): bool {
        return !this.equals(other);
    }
}
