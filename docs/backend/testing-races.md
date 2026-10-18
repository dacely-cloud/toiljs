# Deterministic request races

`WasmServerModule.dispatchAsync(request, hooks)` runs a fresh Wasm request
instance while allowing another request to use the same dev database. It uses
WebAssembly JavaScript Promise Integration (JSPI), so the Node runtime must
provide `WebAssembly.Suspending` and `WebAssembly.promising`. It reports a clear
error when those APIs are unavailable. The normal synchronous dispatcher is
unchanged.

Hooks are `beforeDatabaseOperation(point)` and `afterDatabaseOperation(point)`;
either may return a Promise. The point includes the request, import name,
resolved collection and a copied encoded key (or a batch-key frame for
`get_many`). The after hook also receives the result. Await a barrier inside a
hook to pause that request, run another request to completion, then release the
barrier. Database result-drain and metadata imports are not suspension points.

```ts
let release!: () => void;
let reached!: () => void;
const ready = new Promise<void>(resolve => { reached = resolve; });
const resume = new Promise<void>(resolve => { release = resolve; });
const send = module.dispatchAsync(sendRequest, {
    beforeDatabaseOperation: async point => {
        if (point.operation !== 'data.compare_exchange') return;
        reached();
        await resume;
    },
});
await ready;
await module.dispatchAsync(deleteThreadRequest);
release();
const result = await send;
```

This executes the actual guest code and shared-store operations at the chosen
order; it does not imitate a race by rewriting test database state. Use it to
check caller-observed CAS conflicts and partial-work recovery. It does not
simulate mesh replication delay, storage-node failover or native lease timing.
