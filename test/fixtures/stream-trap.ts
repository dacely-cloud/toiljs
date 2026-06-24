// Dev trap fixture: a `@stream('trap')` whose `@message` deliberately TRAPS (the wasm `unreachable`
// instruction). The dev has no gas-metering middleware, so this stands in for the edge's gas-kill: a
// real trap makes the dispatch throw, which StreamDevHost turns into a STREAM_HOOK_TRAPPED close that
// discards the poisoned box (mirrors toil-backend's poisoned-box containment, 05 7.4).
//
// The trap sits behind an always-true guard so the `return` stays reachable to the type checker.

@stream('trap')
class Trap {
  @message boom(p: StreamPacket): StreamOutbound {
    if (p.length >= 0) {
      unreachable();
    }
    return StreamOutbound.empty();
  }
}

export function probe(): i32 { return 1; }
