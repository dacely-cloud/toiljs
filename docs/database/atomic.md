# Atomic partitioned documents

`Db.atomic(partition, token)` builds an all-or-nothing conditional batch for an
Action. It can write up to sixteen records across `Documents` collections in
one database. All collections must declare `replication: 'localOnly'` and have
no `@unique` fields. An absent-record condition provides uniqueness within the
partition, such as one message per sequence number in a thread.

```ts
@database class Messages {
    @collection({ replication: 'localOnly', placement: 'local' })
    static messages: Documents<MessageKey, Message>;
    @collection({ replication: 'localOnly', placement: 'local' })
    static threads: Documents<ThreadKey, Thread>;
}

const partition = new ThreadId(threadId);
const observed = Messages.threads.partition(partition).getSnapshot(threadKey);
const batch = Db.atomic(partition, stableRequestToken);
batch.create(Messages.messages, messageKey, message);
batch.compareExchange(Messages.threads, threadKey, observed, updatedThread);
if (!batch.commit()) return Response.text('Thread changed; retry', 409);
```

`create(collection, key, value)` requires absence. `compareExchange(collection,
key, snapshot, value)` requires the exact encoded snapshot, or absence if the
snapshot is null. `compareDelete(collection, key, snapshot)` conditionally
deletes a record. Each key may appear once. If any condition fails, `commit()`
returns false and changes no records or decision markers. All input validation
and budget checks happen before the storage commit. Other errors throw.

Partitioned records occupy a separate namespace. Read them through
`collection.partition(partition).get(key)`, `getSnapshot(key)`, or `require(key)`.
Ordinary `collection.get`, `scan`, and mutation methods address ordinary records.
Introducing a partition does not migrate existing data. Every partitioned write
uses `Db.atomic`, including a batch containing one record. Reads are linearizable
and bypass request and replica caches. Separate reads may straddle
a commit; there is no multi-read snapshot API.

The token is 16–64 bytes and identifies one exact batch, including its ordered
keys, expected bytes, new bytes, and schema versions. Retry a lost response with
the same partition, token, and batch inputs. Successful retries return true
without reapplying writes, even after a subsequent update or deletion. Reusing
the token for different inputs fails with a conflict. If an Action rebuilds a
batch from freshly read state, retain the original expected/new values for a
response-loss retry, or check an application-owned receipt before rebuilding.
Decision markers persist with the partition and consume storage.

Partition encodings are 1–512 bytes; record keys are at most 4096 bytes. The
partition, token, keys, expected bytes, new bytes, and 32-byte decision digest
together are capped at 128 KiB. A batch charges one write operation per record
and one for the durable decision, including retry attempts. `Db.budget()` includes
these operations and bytes. Queries, Jobs, and Derives cannot commit batches.
Derive invalidations for committed collections use `fullRescan` because changed
keys alone do not identify the partition.

Native commits the records and decision together in one conditional operation.
All callers for a partition must use the same persistent ToilDB deployment.
`localOnly` data does not replicate between independent POP stores.
Choose a partition per bounded business aggregate, such as a thread; putting all
tenant traffic under one constant partition creates a hotspot. These operations
require the updated native host imports. Existing unpartitioned data retains its
current storage and replication behavior.

The dev emulator validates the same limits and commits synchronously without
callbacks or suspension between mutations; its normal snapshot file persists
both records and successful decisions. Test overlapping requests through the
[DB barrier hook](../backend/testing-races.md).
