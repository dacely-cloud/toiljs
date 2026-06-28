// Dev @connect-bridge fixture: a `@stream('gate')` whose `@connect(c: StreamInbound): StreamOutbound`
// reads the host-written connect context (the path) and REJECTS "/blocked" with 0x0211, ACCEPTING any
// other path; a "/greet" path stages an egress frame DURING @connect (the host returns it as initial
// egress and drains the ring so it does not contaminate the first @message reply). A @message echoes. Mirrors toil-backend's connect_src.ts;
// exercises the whole @connect bridge (stream_info block -> StreamInbound.path() -> accept/reject).

@stream('gate')
class Gate {
    @connect onConnect(c: StreamInbound): StreamOutbound {
        if (c.path() == '/blocked') return StreamOutbound.reject(0x0211);
        if (c.path() == '/greet') {
            const g = new Uint8Array(3);
            g[0] = 0x47;
            g[1] = 0x48;
            g[2] = 0x49; // "GHI"
            StreamOutbound.reply(g);
            return StreamOutbound.accept();
        }
        return StreamOutbound.accept();
    }
    @message reply(p: StreamPacket): StreamOutbound {
        return StreamOutbound.reply(p.bytes());
    }
}

export function probe(): i32 {
    return 1;
}
