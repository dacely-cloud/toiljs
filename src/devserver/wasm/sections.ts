/**
 * Shared, bounds-checked wasm custom-section walker. Factored out of
 * `db/catalog.ts` so the three Toil section parsers (`toildb.catalog`,
 * `toilstream.catalog`, `toildaemon.catalog`, `toil.surface`) share ONE
 * magic-skipping loop instead of drifting copies.
 *
 * Every input is a tenant-built, possibly mid-rebuild wasm, so the walker must
 * never read past the buffer: a truncated/garbage section table returns `null`
 * (treated by callers as "no section"). Mirrors the host-side walker
 * (`toil-backend` custom-section reader) and the toilscript-side test walker.
 */

/** Read a LEB128 from `buf` at `pos`; throws on overrun so a truncated module
 *  can never over-read (the caller catches and treats it as "no section"). */
export function leb(buf: Buffer, pos: number): [number, number] {
    let result = 0;
    let shift = 0;
    let p = pos;
    for (;;) {
        if (p >= buf.length) throw new RangeError('leb128 past end of buffer');
        const b = buf[p++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) throw new RangeError('leb128 too long');
    }
    return [result >>> 0, p];
}

/** The bytes of the named wasm custom section, or `null` if absent. Bounds-checked
 *  so a truncated/garbage module can never read past the buffer. */
export function customSection(wasm: Buffer, want: string): Buffer | null {
    if (
        wasm.length < 8 ||
        wasm[0] !== 0x00 ||
        wasm[1] !== 0x61 ||
        wasm[2] !== 0x73 ||
        wasm[3] !== 0x6d
    )
        return null;
    let pos = 8; // skip the 8-byte magic + version header
    while (pos < wasm.length) {
        const id = wasm[pos++];
        let size: number;
        [size, pos] = leb(wasm, pos);
        const end = pos + size;
        if (end > wasm.length || end < pos) return null; // truncated section table
        if (id === 0) {
            const [nameLen, namePos] = leb(wasm, pos);
            if (
                namePos + nameLen <= end &&
                wasm.toString('latin1', namePos, namePos + nameLen) === want
            )
                return wasm.subarray(namePos + nameLen, end);
        }
        pos = end;
    }
    return null;
}
