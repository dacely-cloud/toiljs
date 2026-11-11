// Dev multi-`@stream` fixture A: a `@stream('alpha')` whose raw `@message` bridge replies with its
// OWN letter (0x41 'A') followed by the inbound bytes. Compiled together with `stream-beta.ts` as ONE
// program (both files passed to toilscript as positional entries, the way `toiljs` invokes it per
// tier), so the artifact carries TWO registered boxes and a `toilstream.catalog` whose entries have
// DISTINCT `stream_index` values.
//
// The letter prefix is the point: the expected reply bytes for the selection tests come from this
// hook body alone, never from the host code under test. If the dev host routes a connection to the
// wrong box, the socket sees the other fixture's letter and the assertion fails.
//
// Top-level names are unique per file: both fixtures are compiled into one program, so a shared
// `probe` / `__count` declaration would collide.

@stream('alpha')
class Alpha {
    @message reply(p: StreamPacket): StreamOutbound {
        const n = p.length;
        const out = new Uint8Array(n + 1);
        out[0] = 0x41; // 'A' - this fixture's own letter, the selection oracle
        for (let i = 0; i < n; i = i + 1) out[i + 1] = p.at(i);
        return StreamOutbound.reply(out);
    }
}

export function alphaProbe(): i32 {
    return 1;
}
