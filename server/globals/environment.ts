// Environment: the per-tenant environment variables + secrets a tenant
// configures OUT OF BAND (a dashboard today, backed by a file; the edge DB
// later) so the deployed `.wasm` carries no credentials — the GitHub-Actions
// model. Available as a no-import global (the toilscript `--lib` mechanism, like
// `AuthService` / `EmailService`).
//
//   const base = Environment.get("PUBLIC_API_BASE");      // plain var, or null
//   const key  = Environment.getSecure("STRIPE_KEY");     // secret, or null
//
// Two DISJOINT buckets (like GitHub `vars.*` vs `secrets.*`): `get` reads ONLY
// plain vars, `getSecure` reads ONLY secrets, so a secret can never come back
// through `get()` (and leak into a log of a `get`). READ-ONLY — there is no
// `set`; a tenant sets values on their dashboard, never from the `.wasm`.
//
// Framework-reserved namespaces (e.g. the email provider config) are HOST-ONLY:
// they are resolved and consumed in Rust where the framework uses them and are
// NEVER reachable here — these imports only see the tenant's own vars/secrets.
//
// Backed by the `env_get` / `env_get_secure` host imports (toil-backend
// `env_get_import.rs`, reading the lazy + bounded `env_cache`, plus the toiljs
// dev-server mock). A tenant that never reads env imports neither, so
// AssemblyScript tree-shakes this away.

// Host imports: copy one value into `outPtr[0..outCap]`. Return the value's byte
// length (`0` = present but empty), `-1` if `outCap` is too small (retry with a
// bigger buffer), `-2` if the key is absent. Resolved from the trusted request
// host, never anything the guest passes.
// @ts-ignore: decorator
@external('env', 'env_get')
declare function __toilEnvGet(keyPtr: usize, keyLen: i32, outPtr: usize, outCap: i32): i32;
// @ts-ignore: decorator
@external('env', 'env_get_secure')
declare function __toilEnvGetSecure(keyPtr: usize, keyLen: i32, outPtr: usize, outCap: i32): i32;

export namespace Environment {
    /** The key is absent from the bucket. */
    const ABSENT: i32 = -2;
    /** The output buffer was too small; retry with a bigger one. */
    const TOO_SMALL: i32 = -1;
    /** First attempt buffer; doubles on `TOO_SMALL`. */
    const INITIAL_CAP: i32 = 256;
    /** Upper bound on a value, matching the host's per-value cap. */
    const MAX_CAP: i32 = 64 * 1024;

    /** Shared reader for both buckets; `secure` picks the secret import. */
    function read(key: string, secure: bool): string | null {
        const keyB = Uint8Array.wrap(String.UTF8.encode(key));
        let cap = INITIAL_CAP;
        while (cap <= MAX_CAP) {
            const buf = new Uint8Array(cap);
            const n = secure
                ? __toilEnvGetSecure(keyB.dataStart, keyB.length, buf.dataStart, cap)
                : __toilEnvGet(keyB.dataStart, keyB.length, buf.dataStart, cap);
            if (n == ABSENT) return null;
            if (n == TOO_SMALL) {
                cap = cap * 2;
                continue;
            }
            if (n < 0) return null; // unknown negative: fail closed
            return String.UTF8.decodeUnsafe(buf.dataStart, n);
        }
        return null; // value larger than MAX_CAP: treat as absent
    }

    /**
     * The plain environment variable `key` (a tenant var, set on the dashboard),
     * or `null` if it is not set. NEVER returns a secret — use {@link getSecure}
     * for those.
     */
    export function get(key: string): string | null {
        return read(key, false);
    }

    /**
     * The secret `key` (a tenant secret, set on the dashboard), or `null` if it
     * is not set. Disjoint from {@link get}: a plain var is never returned here.
     * The value is sensitive — do not log it.
     */
    export function getSecure(key: string): string | null {
        return read(key, true);
    }
}
