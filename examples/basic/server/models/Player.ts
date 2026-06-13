/** A leaderboard player. The `u256` id shows native bignums riding the wire: it crosses
 *  JSON as four 64-bit limbs and lands on the client as one `bigint`. */
@data
export class Player {
    id: u256 = u256.Zero;
    name: string = '';
    score: i64 = 0;
}
