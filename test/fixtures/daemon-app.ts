// A minimal @daemon fixture for the dev daemon-emulation test. It declares the
// `daemon.*` / `mstore.*` host imports directly (so it needs no toiljs globals
// lib) and records its activity into the dev MemoryStore, which the test reads
// back through `devMemoryStore`. Compiled with `--targetMode cold` by the test.
//
//   onStart()          -> mstore.incr("started", 1) and stamps the lease epoch
//   tick()  @scheduled -> mstore.incr("tick:fast", 1)   (1s interval)
//   sixHourly() cron   -> mstore.incr("tick:cron", 1)   (0 */6 * * *)

// @ts-nocheck — this is AssemblyScript source compiled by toilscript, not TS.

@external("env", "mstore.incr")
declare function mstoreIncr(keyPtr: i32, keyLen: i32, delta: i64, ttlSecs: i32): i64;

@external("env", "daemon.is_leader")
declare function daemonIsLeader(): i32;

@external("env", "daemon.current_epoch")
declare function daemonCurrentEpoch(): i64;

@external("env", "daemon.task_count")
declare function daemonTaskCount(): i32;

// Bump the i64 counter stored at the (utf8) `key` by 1. The host reads the key
// bytes straight out of linear memory (handleless mstore, ttl in seconds).
function bump(key: string): void {
    let bytes = String.UTF8.encode(key);
    mstoreIncr(changetype<i32>(bytes), bytes.byteLength, 1, 0);
}

@daemon
class Jobs {
    onStart(): void {
        // Prove leader=true and that the epoch import is callable; record both so
        // the test can assert the stubs from outside.
        bump("started");
        if (daemonIsLeader() == 1) bump("leader");
        let epoch = daemonCurrentEpoch();
        if (epoch >= 0) bump("epoch:nonneg");
        if (daemonTaskCount() == 2) bump("taskcount:2");
    }

    @scheduled("1s")
    tick(): void {
        bump("tick:fast");
    }

    @scheduled("0 */6 * * *")
    sixHourly(): void {
        bump("tick:cron");
    }
}

export function probe(): i32 {
    return 1;
}
