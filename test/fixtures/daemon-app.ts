// A minimal @daemon fixture for the dev daemon-emulation test. It declares the
// daemon host imports directly (so it needs no toiljs globals lib) and records
// its activity into resident daemon wasm memory. Compiled with `--targetMode cold`
// by the test.
//
//   onStart()          -> increments `started` and stamps the lease epoch
//   tick()  @scheduled -> increments `tickFast`   (1s interval)
//   sixHourly() cron   -> increments `tickCron`   (0 */6 * * *)
//
// The imports live in the `daemon` wasm module with BARE names, as the edge
// registers them; they are not dotted names under `env`. toilscript's stdlib
// exposes the same surface as the ambient `Daemon` class (`~lib/daemon`), which
// real daemons should use instead of hand-declaring these.

// @ts-nocheck — this is AssemblyScript source compiled by toilscript, not TS.

@external("daemon", "is_leader")
declare function daemonIsLeader(): i32;

@external("daemon", "current_epoch")
declare function daemonCurrentEpoch(): i64;

@external("daemon", "task_count")
declare function daemonTaskCount(): i32;

let started: i32 = 0;
let leaderSeen: i32 = 0;
let epochNonneg: i32 = 0;
let taskcount2: i32 = 0;
let tickFast: i32 = 0;
let tickCron: i32 = 0;

@daemon
class Jobs {
    onStart(): void {
        // Prove leader=true and that the epoch import is callable; record both so
        // the test can assert the stubs from outside.
        started += 1;
        if (daemonIsLeader() == 1) leaderSeen += 1;
        let epoch = daemonCurrentEpoch();
        if (epoch >= 0) epochNonneg += 1;
        if (daemonTaskCount() == 2) taskcount2 += 1;
    }

    @scheduled("1s")
    tick(): void {
        tickFast += 1;
    }

    @scheduled("0 */6 * * *")
    sixHourly(): void {
        tickCron += 1;
    }
}

export function startedCount(): i32 { return started; }
export function leaderCount(): i32 { return leaderSeen; }
export function epochNonnegCount(): i32 { return epochNonneg; }
export function taskcount2Count(): i32 { return taskcount2; }
export function tickFastCount(): i32 { return tickFast; }
export function tickCronCount(): i32 { return tickCron; }

export function probe(): i32 {
    return 1;
}
