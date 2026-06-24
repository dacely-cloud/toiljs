/**
 * A `@stream` protocol handler mounted at `/echo`.
 *
 * Unlike a `@rest` route (a fresh handler per request), a `@stream` runs as a
 * RESIDENT wasm box per WebTransport connection on the Toil edge: it is created
 * when the connection opens, lives for the connection's lifetime, and is torn
 * down on close. It is distributed across the eligible L2/L3 stream nodes and
 * pinned to ONE worker for the whole connection via QUIC connection-id steering,
 * so its in-box state survives every event.
 *
 * That residency is the whole point: the `count` field below persists across
 * every `@message` because the box is never reset between events (a `@rest`
 * handler's fields would reset each request).
 *
 * On the client (once the message bridge lands - see the NOTE):
 *
 *   const stream = await Server.STREAM.echo.connect();
 *   stream.send(new TextEncoder().encode('hello'));
 *
 * Lifecycle hooks: `@connect` (open), `@message` (an inbound frame), `@close`
 * (graceful close), `@disconnect` (abrupt transport loss).
 *
 * NOTE: reading the inbound frame and replying is the next increment (the
 * `StreamPacket` / `StreamOutbound` message bridge). The intended shape:
 *
 *   @message reply(packet: StreamPacket): StreamOutbound {
 *     return StreamOutbound.reply(packet.bytes());   // echo the bytes back
 *   }
 *
 * Until that lands, the hooks run on the connection lifecycle; this example
 * counts frames to show the resident box keeps state across them.
 */
@stream('echo')
class Echo {
    // Resident per-connection state: survives across events (the box is never reset).
    private count: i32 = 0;

    @connect
    onConnect(): void {
        // A fresh connection: its dedicated box starts the counter at 0.
        this.count = 0;
    }

    @message
    onMessage(packet: StreamPacket): void {
        // Increments on every inbound frame - and PERSISTS across them, because
        // this is the same resident box for the whole connection.
        this.count = this.count + 1;
    }

    @close
    onClose(): void {
        // Graceful close: the per-connection box is torn down after this hook.
    }
}
