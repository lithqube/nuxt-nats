# KV Store

JetStream KV is a key-value store backed by a JetStream stream. Unlike Redis, it's built into NATS — no separate service required. It supports get, put, delete, watch (change stream), and TTL per entry.

## Basic usage

```ts
// server/api/session.ts
export default defineEventHandler(async (event) => {
  const kv = await useKV('sessions')

  // Put
  await kv.put('user:123', JSON.stringify({ role: 'admin', lastSeen: Date.now() }))

  // Get
  const entry = await kv.get('user:123')
  if (!entry) return null

  return JSON.parse(entry.string())
})
```

`useKV(bucket)` opens the bucket and caches the handle for the lifetime of the process. Subsequent calls with the same bucket name return the cached handle immediately.

## Create a bucket with options

Pass options on the **first** call to create the bucket if it doesn't exist:

```ts
const kv = await useKV('sessions', {
  history: 5,              // keep last 5 revisions per key
  ttl: 3_600_000,          // entry TTL in ms (1 hour)
  storage: 'file',         // 'file' | 'memory'
  replicas: 1,
})
```

If the bucket already exists, options are ignored and the existing bucket is returned.

## Operations

```ts
const kv = await useKV('cache')

// Write
await kv.put('key', 'value')

// Read
const entry = await kv.get('key')
entry?.string()      // raw string
entry?.json()        // parsed JSON

// Delete (tombstone — history preserved)
await kv.delete('key')

// Purge (remove all revisions for a key)
await kv.purge('key')

// Check revision for optimistic locking
const entry = await kv.get('counter')
await kv.update('counter', '42', entry!.revision)   // fails if revision changed
```

## Watching for changes

Watch all keys or a specific key/prefix for changes:

```ts
// server/plugins/cache-sync.ts
export default defineNitroPlugin(async () => {
  const kv = await useKV('config')
  const watcher = await kv.watch()

  ;(async () => {
    for await (const entry of watcher) {
      if (entry.operation === 'PUT') {
        console.log(`Config updated: ${entry.key} = ${entry.string()}`)
      }
    }
  })()
})
```

Watch a specific key:

```ts
const watcher = await kv.watch({ key: 'feature-flags.*' })
```

## Typed helpers

Wrap `useKV` to add JSON encode/decode and type safety:

```ts
// server/utils/useTypedKV.ts
export async function useTypedKV<T>(bucket: string) {
  const kv = await useKV(bucket)
  return {
    async get(key: string): Promise<T | null> {
      const entry = await kv.get(key)
      if (!entry) return null
      return JSON.parse(entry.string()) as T
    },
    async put(key: string, value: T): Promise<void> {
      await kv.put(key, JSON.stringify(value))
    },
    async delete(key: string): Promise<void> {
      await kv.delete(key)
    },
  }
}
```

Usage:

```ts
interface UserSession { role: string; lastSeen: number }

const sessions = await useTypedKV<UserSession>('sessions')
await sessions.put('user:123', { role: 'admin', lastSeen: Date.now() })
const session = await sessions.get('user:123')  // UserSession | null
```

## Bucket TTL vs entry TTL

- **Bucket TTL** (`ttl` in options): A default TTL applied to all entries in the bucket. Entries expire automatically.
- **Entry-level TTL:** Not directly supported in the KV API — use bucket TTL or implement expiry by storing a timestamp and checking on read.

## Differences from Redis

| Feature | NATS KV | Redis |
|---|---|---|
| History / revisions | ✅ configurable | ❌ |
| Watch (change stream) | ✅ built-in | Requires keyspace notifications |
| TTL per bucket | ✅ | ✅ per key |
| Atomic CAS (update) | ✅ via revision | ✅ via Lua / transactions |
| Persistence | ✅ file storage | ✅ AOF / RDB |
| Clustering / replicas | ✅ JetStream cluster | ✅ Redis Cluster |
| Pub/sub | ✅ via NATS core | ✅ |
| Sorted sets / lists | ❌ | ✅ |
| Separate service | ❌ built into NATS | ✅ requires Redis |
