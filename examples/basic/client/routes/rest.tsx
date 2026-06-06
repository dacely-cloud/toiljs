// Demo of the generated REST fetch client (see ../../shared/server.ts, emitted by the
// server build from the `@rest` controllers in server/api.ts). Unlike `Server.<service>`
// RPC, this is working code: `Server.REST.<controller>.<route>(args)` is a real, typed
// `fetch`. `args` is `{ params?, body?, query?, headers? }`; a `@data` return is parsed
// into its typed class, and a route that returns a `Response` hands you the raw fetch
// `Response` to inspect (status, `.json()`, ...). Needs the server running to respond.
import { useState } from 'react';

import { NewPlayer, ScoreDelta } from 'shared/server';

export default function RestDemo() {
    const [log, setLog] = useState<string[]>([]);
    const note = (line: string) => setLog((prev) => [line, ...prev].slice(0, 8));

    // POST /players  ->  typed Promise<Player>, body is a @data class. The server returns the
    // new player, but it is NOT saved (server memory resets per request); this is a preview.
    const onCreate = async () => {
        try {
            const names = ['Bob', 'Dennis', 'Margaret', 'Ken'];
            const name = names[Math.floor(Math.random() * names.length)];
            const player = await Server.REST.players.create({ body: new NewPlayer(name) });
            note(`created #${player.id} ${player.name} (preview - not persisted)`);
        } catch (err) {
            note(parseError(err));
        }
    };

    // POST /players/:id/score  ->  path param + body, typed Promise<Player>. The score change
    // applies to this response only (not persisted).
    const onScore = async () => {
        try {
            const points = BigInt(1 + Math.floor(Math.random() * 10));
            const p = await Server.REST.players.addScore({
                params: { id: 1 },
                body: new ScoreDelta(points)
            });
            note(`#${p.id} ${p.name} +${points} -> ${p.score} (preview)`);
        } catch (err) {
            note(parseError(err));
        }
    };

    // GET /players/:id  ->  this route returns a Response, so the client gets the raw fetch
    // Response (read its status, headers, and body yourself). #1 is a seeded player.
    const onGet = async () => {
        try {
            const res = await Server.REST.players.get({ params: { id: 1 } });
            if (!res.ok) {
                note(`get #1 -> ${res.status}`);
                return;
            }
            const p = await res.json();
            note(`#${p.id} ${p.name} (cache-control: ${res.headers.get('cache-control')})`);
        } catch (err) {
            note(parseError(err));
        }
    };

    // GET /leaderboard  ->  typed Promise<Standings>, a @data wrapper of Player[].
    const onBoard = async () => {
        try {
            const board = await Server.REST.leaderboard.top();
            note('leaderboard: ' + board.players.map((p) => `${p.name}(${p.score})`).join(', '));
        } catch (err) {
            note(parseError(err));
        }
    };

    return (
        <main>
            <h1>REST</h1>
            <p>
                <code>Server.REST.*</code> is a real, typed <code>fetch</code> client generated from the{' '}
                <code>@rest</code> controllers. It needs the server running to respond. The server runs a fresh instance
                per request, so the players are re-seeded each time and writes are previews (persist to a database to
                keep them).
            </p>
            <button onClick={onCreate}>create player</button> <button onClick={onScore}>award points to #1</button>{' '}
            <button onClick={onGet}>get #1 (raw Response)</button> <button onClick={onBoard}>leaderboard</button>
            <ul>
                {log.map((line, i) => (
                    <li key={i}>{line}</li>
                ))}
            </ul>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}
