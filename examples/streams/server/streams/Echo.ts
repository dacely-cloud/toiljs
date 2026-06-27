/**
 * A `@stream` protocol handler mounted at `/echo`.
 *
 * A `@stream` box is RESIDENT for the life of ONE connection: created on `@connect`, it handles every
 * `@message` on that connection (on the Toil edge pinned to one worker for the connection's life via
 * QUIC connection-id steering), and is DESTROYED on `@close`. In-box state persists across the messages
 * of a SINGLE connection, but NOT beyond it: the next connection (and a reconnect) gets a brand-new box
 * that starts clean, and a box is never reused across connections, so one connection's state can never
 * leak into another. For state that must outlive the connection, use `@data` / the DB, not a class field.
 *
 * On the client, the typed client is generated as `Server.Stream.Echo` (into `shared/server.ts`):
 *
 *   const echo = await Server.Stream.Echo.connect();
 *   echo.onMessage((bytes) => { ... });             // the echoed reply frame
 *   echo.send(new TextEncoder().encode('hello'));
 *
 * Lifecycle hooks: `@connect` (open), `@message` (an inbound frame - here read via `StreamPacket` and
 * echoed back via `StreamOutbound`), `@close` (graceful close), `@disconnect` (abrupt transport loss).
 * `count` is per-connection scratch: it advances across this connection's frames and resets to 0 on the
 * next connection.
 */
@stream('echo')
class Echo {
    // Per-CONNECTION scratch: persists across this connection's messages, reset to 0 on the next
    // connection (the box is destroyed on close). NOT durable - use @data to survive a reconnect.
    private count: i32 = 0;

    @connect
    onConnect(): void {
        // A fresh connection gets its OWN new box; the counter starts at 0.
        this.count = 0;
    }

    @message
    onMessage(packet: StreamPacket): StreamOutbound {
        // Advances on every frame of THIS connection - persists across them because it is the same
        // resident box for the connection's life - then echoes the inbound bytes straight back.
        this.count = this.count + 1;
        return StreamOutbound.reply(packet.bytes());
    }

    @close
    onClose(): void {
        // Graceful close: the box is DESTROYED after this hook (the next connection starts clean).
    }
}
