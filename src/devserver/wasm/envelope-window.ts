/** The edge reserves bytes below the first active data segment for requests. */
export function envelopeWindowOf(wasm: Buffer): number | null {
    if (wasm.length < 8 || !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
        throw new Error('invalid wasm header');
    let pos = 8;
    let end = wasm.length;
    let window: number | null = null;
    const byte = (): number => {
        if (pos >= end) throw new Error('truncated wasm data section');
        return wasm[pos++];
    };
    const integer = (signed = false): number => {
        let value = 0;
        let shift = 0;
        for (let i = 0; i < 5; i++) {
            const b = byte();
            value += (b & 127) * 2 ** shift;
            shift += 7;
            if ((b & 128) === 0) {
                if (signed && b & 64) value -= 2 ** shift;
                if (
                    value < (signed ? -0x80000000 : 0) ||
                    value > (signed ? 0x7fffffff : 0xffffffff)
                )
                    throw new Error('invalid wasm data integer');
                return value;
            }
        }
        throw new Error('invalid wasm data integer');
    };
    while (pos < wasm.length) {
        end = wasm.length;
        const id = byte();
        const size = integer();
        end = pos + size;
        if (end > wasm.length) throw new Error('truncated wasm section');
        if (id === 11) {
            const count = integer();
            for (let i = 0; i < count; i++) {
                const flags = integer();
                if (flags === 0 || flags === 2) {
                    if (flags === 2 && integer() !== 0) throw new Error('unsupported data memory');
                    if (byte() !== 0x41) throw new Error('data offset must be a constant i32');
                    const offset = integer(true);
                    if (offset < 0 || byte() !== 0x0b) throw new Error('invalid data offset');
                    window = window === null ? offset : Math.min(window, offset);
                } else if (flags !== 1) throw new Error('unsupported data segment flags');
                const length = integer();
                pos += length;
                if (pos > end) throw new Error('truncated wasm data segment');
            }
            if (pos !== end) throw new Error('invalid wasm data section framing');
        }
        pos = end;
    }
    return window;
}
