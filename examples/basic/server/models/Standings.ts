import { Player } from './Player';

/** A leaderboard page. A `@data` wrapper so the `Player[]` round-trips through the codec. */
@data
export class Standings {
    players: Player[] = [];
}
