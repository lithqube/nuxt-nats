# KV and Object Store with nuxt-nats

Both are auto-imported and cached per process (one handle per bucket name).

## `useKV(bucket, opts?)`

- **With `opts`** it creates the bucket if absent. **Without `opts`** it opens an existing bucket and fails if there is none.
- `opts`: `history` (revisions per key, default 1), `ttl` (**milliseconds**), `storage` (`'file'` default), `replicas`.

```ts
const kv = await useKV('sessions', { history: 5, ttl: 3_600_000 })

await kv.put('user.123', JSON.stringify({ lastSeen: Date.now() }))   // value is a string or bytes, NOT an object
const entry = await kv.get('user.123')                                // null when missing
if (entry && entry.operation === 'PUT') {
  const value = entry.json<{ lastSeen: number }>()
  // optimistic concurrency: fails when the revision moved
  await kv.update('user.123', JSON.stringify({ lastSeen: Date.now() }), entry.revision)
}
```

- `entry.operation` is `'PUT' | 'DEL' | 'PURGE'`. A `DEL` or `PURGE` entry is a tombstone, not a value: check before reading it.
- `delete(key)` writes a tombstone and keeps history; `purge(key)` removes all revisions.
- Keys match `[-/_=.a-zA-Z0-9]+`. A `:` is not allowed, so use `.` or `/`.
- **TTL units differ across the ecosystem.** In `@nats-io/kv` (what the module uses) a bucket `ttl` is milliseconds; `nats-py` takes float seconds; the `nats` CLI takes a duration string (`--ttl 72h`). Mixing them makes keys never expire or expire at once.
- Per-key TTL and delete markers need a recent server and stream settings. Without markers an expiring key disappears with **no watcher event**, which silently breaks cache-invalidation designs that watch the bucket.
- Client 3.5: a bucket uses its own `timeout`, or inherits the JetStream client's (5 s default); `keys()` and `history()` fail with an "incomplete" error instead of returning a partial list (they are async iterators and can yield entries before the error, so collect the whole result before acting on it); `watch()`, `keys()` and `history()` fail with `PermissionViolationError` when the connection may not publish the flow-control reply.

## `useObj(bucket, opts?)`

Same create-vs-open rule as `useKV`. `opts`: `storage`, `replicas`, `description`, `ttl` in **nanoseconds** (use `nanos(ms)` from `@nats-io/nats-core`; this differs from KV).

```ts
const obs = await useObj('uploads', { storage: 'file' })

// put() takes a Web ReadableStream<Uint8Array>, NOT a Node Buffer
const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(buf)); c.close() } })
await obs.put({ name: 'invoice.pdf', description: 'user upload' }, body)

await obs.putBlob({ name: 'small.bin' }, new Uint8Array(buf))   // simpler for small bytes

const res = await obs.get('invoice.pdf')    // null when missing; res.data is a ReadableStream, res.info the metadata
```

- Wrapping a `Buffer` in a `ReadableStream` is the most common mistake; `get()` returns a stream too, so pipe it through the Nitro response.
- `max_chunk_size` is a per-object `put()` option, not a bucket option.
- Client 3.5: `list()` reads metadata, not chunks, so a successful `list()` is not an integrity check (it fails with "list incomplete" only when the listing cannot finish). `get()` returns before the data is read: a missing chunk ("object read incomplete"), digest mismatch or flow-control permission error surfaces on the `res.data` stream, and `res.error` (a promise) resolves to the error instead of rejecting. Handle errors where you consume the stream.
- Updates replace the whole object; there is no partial update.

## When not to reach for these

If a Postgres table or your existing blob store already fits, a NATS bucket adds a failure domain for no gain. Use KV for a replicated, watchable, TTL'd key space next to your streams, and Object Store for blobs on the same bus when you do not want to stand up S3.
