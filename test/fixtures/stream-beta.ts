// Dev multi-`@stream` fixture B: the sibling of `stream-alpha.ts`. A `@stream('beta')` whose raw
// `@message` bridge replies with its OWN letter (0x42 'B') followed by the inbound bytes.
//
// Compiled with `stream-alpha.ts` as one program so the artifact registers two boxes; this one is
// the SECOND entry in the catalog, i.e. the box a route-selected connection must reach instead of
// the default handler 0. The distinct letter is the oracle: a host that always dispatches at index 0
// answers a `/beta` connection with Alpha's 'A', which is exactly the pre-plumbing failure this
// fixture exists to catch.

@stream('beta')
class Beta {
    @message reply(p: StreamPacket): StreamOutbound {
        const n = p.length;
        const out = new Uint8Array(n + 1);
        out[0] = 0x42; // 'B' - this fixture's own letter, the selection oracle
        for (let i = 0; i < n; i = i + 1) out[i + 1] = p.at(i);
        return StreamOutbound.reply(out);
    }
}

export function betaProbe(): i32 {
    return 1;
}
