// Dev-stream emulation fixture: a `@stream('echo')` whose raw `@message` bridge echoes the inbound
// bytes back through the egress ring, rejects an 'X'-prefixed frame (0x0210), and `empty()`s a
// zero-length frame. Compiled by the dev test with the LOCAL toilscript (`--targetMode hot`), then
// driven through `DevStreamBox`. Mirrors toil-backend's `tests/fixtures/stream/echo_src.ts`.

let __count: i32 = 0;

// Observable so the @message hook's residency can be asserted across events.
export function messageCount(): i32 {
  return __count;
}

@stream('echo')
class Echo {
  @message reply(p: StreamPacket): StreamOutbound {
    __count = __count + 1;
    const n = p.length;
    if (n == 0) return StreamOutbound.empty();
    if (p.at(0) == 0x58) return StreamOutbound.reject(0x0210); // 'X' -> reject
    return StreamOutbound.reply(p.bytes());
  }
}

export function probe(): i32 {
  return 1;
}
