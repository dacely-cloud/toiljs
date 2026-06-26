/**
 * A `@stream` protocol handler mounted at `/echo` - the SERVER side of the Realtime feature.
 *
 * Unlike a `@rest` route (a fresh handler per request), a `@stream` runs as a RESIDENT wasm box per
 * connection: it is created on `@connect`, lives for the whole connection, and is torn down on `@close`.
 * On the Toil edge that box is distributed across the L2/L3 stream nodes and pinned to ONE worker for the
 * connection's life via QUIC connection-id steering, so its in-box state survives every event.
 *
 * The `count` field below is the proof: it persists across every `@message` because the box is never
 * reset between events (a `@rest` handler's fields reset each request). Each reply carries the running
 * count, so the client can watch the SAME resident box advance.
 *
 * Two browser clients drive this exact box (both land here in dev over a WebSocket, and on the edge over
 * WebTransport):
 *   - the raw socket:   Toil.useChannel({ path: '/echo' })   (client/routes/features/realtime.tsx)
 *   - the typed stream: await Server.Stream.Echo.connect()    (client/routes/features/stream.tsx)
 */
@stream('echo')
class Echo {
    // Resident per-connection state: survives across events (the box is never reset between them).
    private count: i32 = 0;

    @connect
    onConnect(): void {
        // A fresh connection: its dedicated box starts the counter at 0.
        this.count = 0;
    }

    @message
    onMessage(packet: StreamPacket): StreamOutbound {
        // Count every inbound frame - and PERSIST across them, because this is the same resident box for
        // the whole connection - then reply with the running count so the client sees it advance.
        this.count = this.count + 1;
        // The count proves residency (the same box handled every frame); the inbound length proves the
        // frame arrived. We avoid decoding the inbound here to keep the handler bytes-safe.
        const reply = 'pong #' + this.count.toString() + ' (' + packet.bytes().length.toString() + ' bytes in)';
        return StreamOutbound.reply(Uint8Array.wrap(String.UTF8.encode(reply)));
    }

    @close
    onClose(): void {
        // Graceful close: the per-connection box is torn down after this hook.
    }
}
