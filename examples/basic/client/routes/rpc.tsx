// Demo of the generated, typed `Server` surface (see ../../shared/server.ts, emitted
// by the server build). `Server` is global (no import), typed from the server: scalars
// (Server.ping(10)) and structs built on the client and passed in. The @data classes
// are constructed with their generated constructor. Transport is not wired yet, so a
// real call throws; this page shows the typing and reports the stub error via the
// global `parseError`.
import { useState } from 'react';

import { AddTodo } from 'shared/server';

export default function RpcDemo() {
    const [result, setResult] = useState('not called');

    // Scalar in / scalar out: Server.ping is typed (n: number) => Promise<number>.
    const onPing = async () => {
        try {
            const next = await Server.ping(10);
            setResult(`ping -> ${next}`);
        } catch (err) {
            setResult(parseError(err));
        }
    };

    // Struct in / struct out: build a @data class on the client and pass it.
    const onAdd = async () => {
        try {
            const input = new AddTodo('buy milk');
            const todo = await Server.todos.add(input); // typed Promise<Todo>
            setResult(`added "${todo.title}" (id ${todo.id})`);
        } catch (err) {
            setResult(parseError(err));
        }
    };

    return (
        <main>
            <h1>RPC</h1>
            <p>
                <code>Server</code> is typed from the server build, no import. Calling throws until
                the transport lands.
            </p>
            <button onClick={onPing}>Server.ping(10)</button>{' '}
            <button onClick={onAdd}>Server.todos.add(new AddTodo(…))</button>
            <p>{result}</p>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}
