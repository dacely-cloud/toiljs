// Fixture for the generated-client JSON wire-format test (test/rpc-bignum-wire.test.ts).
// Compiled by the installed toilscript with --rpcModule, then the generated TS client is
// imported and exercised. Covers every JSON bignum width plus a nested @data so the
// recursive toJSONValue path is hit.

@data
class Wallet {
    u: u64 = 0;
    i: i64 = 0;
    a: u128 = u128.Zero;
    b: i128 = i128.Zero;
    c: u256 = u256.Zero;
    d: i256 = i256.Zero;
    label: string = '';
}

@data
class Account {
    main: Wallet = new Wallet();
    ids: u256[] = [];
}

// A free @remote so buildServerModule emits a surface (it returns null otherwise).
@remote
function touch(n: i32): i32 {
    return n;
}
