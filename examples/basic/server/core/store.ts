// The demo's shared state, used by the routes and services.
//
// IMPORTANT - the server runs with a FRESH WebAssembly instance per request, so linear memory
// (and any module-level state, like the `store` below) is reset on every request. It does NOT
// persist across requests. We seed a few players at module init so the read routes always have
// data; writes take effect only for the current request's response. For real persistence, call
// out to a database or KV store from your handler.

import { Player } from '../models/Player';

/** Players by id, re-seeded on EVERY request (see the note above). */
export const store = new Map<u64, Player>();

let nextId: u64 = 1;

/** The next fresh player id (module-local so callers cannot desync it). */
export function allocId(): u64 {
    return nextId++;
}

function seed(name: string, score: i64): void {
    const p = new Player();
    p.id = u256.fromU64(allocId());
    p.name = name;
    p.score = score;
    store.set(p.id.toU64(), p);
}

seed('Ada', 120);
seed('Linus', 95);
seed('Grace', 140);
