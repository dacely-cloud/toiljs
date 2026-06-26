/** Free `@remote` functions: callable as `Server.<name>()` on the client. */

/** `Server.ping(n)` on the client. */
@remote
function ping(n: i32): i32 {
    return n + 1;
}

/** `Server.echoParts(parts)` — exercises the `Uint8Array[]` arg + result wire (writeBytes/readBytes loop). */
@remote
function echoParts(parts: Uint8Array[]): Uint8Array[] {
    return parts;
}
