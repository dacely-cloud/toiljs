import { store } from '../core/store';
import { Player } from '../models/Player';
import { Standings } from '../models/Standings';

/**
 * The leaderboard, mounted at `/leaderboard`. On the client:
 *   const board = await Server.REST.leaderboard.top(); // typed Standings { players: Player[] }
 */
@rest('leaderboard')
class Leaderboard {
    /** `GET /leaderboard` - the seeded players, highest score first. */
    @get('/')
    public top(): Standings {
        const board = new Standings();
        const all = store.values();
        for (let i = 0; i < all.length; i++) board.players.push(all[i]);
        board.players.sort((a: Player, b: Player): i32 => (a.score < b.score ? 1 : a.score > b.score ? -1 : 0));
        return board;
    }
}
