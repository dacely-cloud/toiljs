/**
 * A `@stream` protocol handler mounted at `/echo`, running as a RESIDENT wasm box
 * per WebTransport connection on the Toil edge - distributed across the eligible
 * L2/L3 nodes and pinned to ONE worker for the connection's lifetime via QUIC
 * connection-id steering.
 *
 * The defining property of a `@stream` (vs a `@rest` handler): the box is
 * RESIDENT, so instance state PERSISTS across events on the same connection. Here
 * `count` survives every `@message` because the box is never reset between events
 * - unlike a `@rest` handler, which is fresh per request. On the client:
 *
 *   const stream = await Server.STREAM.echo.connect();
 *   stream.send(new TextEncoder().encode('hi'));
 *
 * Lifecycle hooks: `@connect` (open), `@message` (an inbound frame), `@close`
 * (graceful close), `@disconnect` (abrupt transport loss).
 *
 * NOTE: reading the inbound frame and replying is the NEXT increment (the
 * `StreamPacket` / `StreamOutbound` message bridge). The intended shape is:
 *
 *   @message reply(packet: StreamPacket): StreamOutbound {
 *     return StreamOutbound.reply(packet.bytes());   // echo the bytes back
 *   }
 *
 * Until that lands, the hooks run on the connection lifecycle; this example counts
 * frames to demonstrate that the resident box keeps state across them.
 */
@stream('echo')
class Echo {
    // Resident per-connection state: survives across events (ResetMode::None).
    private count: i32 = 0;

    @connect
    onConnect(): void {
        // A fresh connection: its dedicated box starts the counter at 0.
        this.count = 0;
    }

    @message
    onMessage(): void {
        // Persists across frames because the box is resident, not reset per event.
        this.count = this.count + 1;
    }

    @close
    onClose(): void {
        // Graceful close: the per-connection box is torn down after this hook.
    }
}
