/**
 * The dev-server RPC DB-kind resolution (audit #2): an `@action` @remote may write; a plain/read-only
 * @remote (absent from `toildb.rpc_kinds`) defaults to read-only Query, matching the edge host gate.
 */
import { describe, expect, it } from 'vitest';

import { rpcKindForId, type RpcKindEntry } from '../src/devserver/db/routeKinds.js';
import { DbFunctionKind } from '../src/devserver/db/types.js';

describe('rpcKindForId', () => {
    it('returns the @action kind for a listed id, and read-only Query for an absent one', () => {
        const methods: RpcKindEntry[] = [{ methodId: 42, kind: DbFunctionKind.Action }];
        expect(rpcKindForId(methods, 42)).toBe(DbFunctionKind.Action);
        // An id NOT in rpc_kinds (a plain/read-only @remote) defaults to Query - the safe default.
        expect(rpcKindForId(methods, 999)).toBe(DbFunctionKind.Query);
        expect(rpcKindForId([], 42)).toBe(DbFunctionKind.Query);
    });
});
