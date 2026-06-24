/**
 * A `@daemon` - the L4 background-worker tier.
 *
 * It compiles into its OWN artifact, `build/server/release-cold.wasm`, and runs as
 * a SINGLE leader-elected resident box per domain on the Toil edge (warm standby,
 * at-most-once failover), firing its `@scheduled` tasks on their cadence. Unlike a
 * request handler (fresh per request) or a stream box (one per connection), there
 * is exactly ONE daemon per domain - the global coordination tier.
 */
@daemon
class Jobs {
    @scheduled('1h')
    hourly(): void {
        // Runs once an hour on the elected leader. Put recurring background work
        // here (rollups, cleanup, polling an upstream, ...).
    }
}
