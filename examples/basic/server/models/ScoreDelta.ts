/** Request body for `POST /players/:id/score` - points to add to a player's score. */
@data
export class ScoreDelta {
    points: i64 = 0;
}
