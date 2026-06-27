/**
 * A `@stream` protocol handler mounted at `/echo` - the SERVER side of the Realtime feature.
 *
 * A `@stream` box is RESIDENT for the life of ONE connection: created on `@connect`, it handles every
 * `@message` on that connection (on the Toil edge it is pinned to one worker for the connection's life
 * via QUIC connection-id steering), and is DESTROYED on `@close`. So in-box state persists across the
 * messages of a SINGLE connection - but it does NOT survive the connection. The next connection (and a
 * reconnect) gets a brand-new box that starts clean, and a box is NEVER reused across connections, so
 * one connection's state can never leak into another.
 *
 * => Box fields are per-connection scratch ONLY. For state that must outlive the connection (survive a
 *    reconnect, or be shared/durable), use `@data` / the DB - never a class field.
 *
 * The `count` below is exactly that per-connection scratch: it advances across THIS connection's frames
 * and resets to 0 the next time someone connects.
 *
 * Two browser clients drive this box (over a WebSocket in dev, WebTransport on the edge):
 *   - the raw socket:   Toil.useChannel({ path: '/echo' })   (client/routes/features/realtime.tsx)
 *   - the typed stream: await Server.Stream.Echo.connect()    (client/routes/features/stream.tsx)
 */
@stream('echo')
class Echo {
    // Per-CONNECTION scratch: persists across this connection's messages, gone when it closes (the box
    // is destroyed). NOT durable - use @data for anything that must survive a reconnect.
    private count: i32 = 0;

    @connect
    onConnect(): void {
        // A fresh connection gets its OWN new box; the counter starts at 0.
        this.count = 0;
    }

    @message
    onMessage(packet: StreamPacket): StreamOutbound {
        // Advances on every frame of THIS connection - and persists across them, because it is the same
        // resident box for the connection's life - then replies with the running count.
        this.count = this.count + 1;
        const reply = 'pong #' + this.count.toString() + ' (' + packet.bytes().length.toString() + ' bytes in)';
        return StreamOutbound.reply(Uint8Array.wrap(String.UTF8.encode(reply)));
    }

    @close
    onClose(): void {
        // Graceful close: the box is DESTROYED after this hook, so the next connection starts clean and
        // no state leaks across connections.
    }
}
