// Demo RPC surface. @data types + @remote/@service become a typed `Server` on the
// client when the server is built (toilscript --rpcModule). Transport is not wired
// yet, so client calls throw until that lands.

@data
class Todo {
    id: u64 = 0;
    title: string = '';
    done: bool = false;
}

@data
class AddTodo {
    title: string = '';
}

@service
class Todos {
    @remote add(input: AddTodo): Todo {
        const t = new Todo();
        t.title = input.title;
        return t;
    }
}

@remote
function ping(n: i32): i32 {
    return n + 1;
}
