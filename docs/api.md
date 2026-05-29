# API Reference

All server utilities are auto-imported in the `server/` directory. No import statements required.

---

## useNats()

Returns the singleton `NatsConnection`. Throws if the connection has not been established (i.e., the module failed to connect on boot).

```ts
function useNats(): NatsConnection
```

Use for raw NATS operations not covered by the higher-level utils:

```ts
// Core subscribe (ephemeral, no JetStream durability)
const sub = useNats().subscribe('metrics.>')
for await (const msg of sub) {
  console.log(msg.subject, msg.string())
}

// Request/reply
const response = await useNats().request('rpc.ping', 'hello', { timeout: 2000 })
console.log(response.string())

// Connection info
console.log(useNats().getServer())    // current server URL
console.log(useNats().isClosed())     // true if connection is closed
```

---

## useJetStream()

Returns the singleton `JetStreamClient`. Throws if JetStream is not available.

```ts
function useJetStream(): JetStreamClient
```

Use for direct JetStream operations beyond what `jsPublish` and `defineNatsConsumer` expose:

---

## useJetStreamIfAvailable()

Returns the singleton `JetStreamClient`, or `null` if the NATS connection has not yet been established. Use in handlers where you want a clean `503` instead of an unhandled `500`.

```ts
function useJetStreamIfAvailable(): JetStreamClient | null
```

```ts
export default defineEventHandler(async (event) => {
  const js = useJetStreamIfAvailable()
  if (!js) throw createError({ statusCode: 503, message: 'NATS not available' })
  // ...
})
```

---

## useNatsHooks(hooks)

Register callbacks for NATS connection lifecycle events. Call from a Nitro plugin. Multiple calls accumulate — all registered callbacks are invoked in registration order. Hook errors are isolated and never affect the module.

```ts
function useNatsHooks(hooks: {
  onConnectError?: (err: Error) => void | Promise<void>
  onReconnect?: (server: string) => void | Promise<void>
  onDisconnect?: (server: string) => void | Promise<void>
}): void
```

| Hook | When it fires |
|---|---|
| `onConnectError` | Initial connection attempt fails on boot |
| `onReconnect` | Client successfully reconnects after a disconnect |
| `onDisconnect` | Client loses its connection to a server |

```ts
// server/plugins/nats-hooks.ts
export default defineNitroPlugin(() => {
  useNatsHooks({
    onConnectError: (err) => logger.error('NATS connect failed', err),
    onReconnect: (server) => metrics.increment('nats.reconnect', { server }),
    onDisconnect: (server) => logger.warn('NATS disconnected', { server }),
  })
})
```

---

## useEphemeralConsumer(opts)

Creates a request-scoped ordered ephemeral JetStream consumer. Designed for SSE endpoints that wait for a single matching event. Manages timeout and client-disconnect cleanup automatically.

```ts
async function useEphemeralConsumer(opts: EphemeralConsumerOptions): Promise<EphemeralConsumerHandle>
```

**EphemeralConsumerOptions:**

| Field | Type | Default | Description |
|---|---|---|---|
| `stream` | `string` | — | JetStream stream name |
| `filterSubjects` | `string[]` | — | Subject filter(s) for the ordered consumer |
| `onMessage` | `(msg: JsMsg) => Promise<boolean \| void> \| boolean \| void` | — | Called per message. Return `true` to stop; `false`/void to continue. Per-message errors are caught and swallowed — the loop continues. |
| `timeoutMs` | `number` | `30_000` | Total wait timeout in ms |
| `onTimeout` | `() => Promise<void> \| void` | — | Called when `timeoutMs` elapses with no match |
| `onDisconnect` | `() => Promise<void> \| void` | — | Called when `handle.stop()` is called before a match (client disconnected) |

**EphemeralConsumerHandle:**

```ts
interface EphemeralConsumerHandle {
  stop(): void   // idempotent
}
```

```ts
// server/api/orders/[id]/status.get.ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const stream = createEventStream(event)

  const handle = await useEphemeralConsumer({
    stream: 'ORDERS',
    filterSubjects: ['orders.*.shipped'],
    timeoutMs: 30_000,
    async onMessage(msg) {
      const payload = JSON.parse(new TextDecoder().decode(msg.data))
      if (payload.id !== id) return false    // not ours — keep waiting
      msg.ack()
      await stream.push({ event: 'shipped', data: JSON.stringify(payload) })
      await stream.close()
      return true                            // done
    },
    onTimeout: async () => {
      await stream.push({ event: 'timeout', data: '{}' })
      await stream.close()
    },
  })

  stream.onClosed(() => handle.stop())       // client disconnected
  return stream.send()
})
```

---

## useJetStream() (continued)

```ts
const js = useJetStream()

// Direct publish (no retry)
await js.publish('orders.created', encoder.encode(JSON.stringify(data)))

// Consumer access
const consumer = await js.consumers.get('ORDERS', 'billing')
const iter = await consumer.consume()
```

---

## useJetStreamManager()

Returns the singleton `JetStreamManager`. Use for stream/consumer management operations.

```ts
function useJetStreamManager(): JetStreamManager
```

```ts
const jsm = useJetStreamManager()

// Stream info
const info = await jsm.streams.info('ORDERS')

// Consumer list
const consumers = await jsm.consumers.list('ORDERS').next()

// Account info
const account = await jsm.getAccountInfo()
console.log(account.streams, account.consumers)
```

---

## useKV(bucket, opts?)

Opens a JetStream KV bucket. Results are cached per bucket name within the process lifetime.

```ts
function useKV(bucket: string, opts?: Partial<KvOptions>): Promise<KV>
```

| Parameter | Type | Description |
|---|---|---|
| `bucket` | `string` | Bucket name |
| `opts` | `Partial<KvOptions>` | Options applied only on first open (creates bucket if missing) |

**Options:**

| Field | Type | Description |
|---|---|---|
| `history` | `number` | Max revisions per key. Default: 1 |
| `ttl` | `number` | Entry TTL in ms. Default: none |
| `storage` | `'file' \| 'memory'` | Storage backend. Default: `'file'` |
| `replicas` | `number` | Replication factor. Default: 1 |

**KV methods:**

```ts
const kv = await useKV('sessions')

await kv.put(key, value)                      // string value
await kv.get(key)                             // KvEntry | null
await kv.delete(key)                          // tombstone
await kv.purge(key)                           // remove all revisions
await kv.update(key, value, lastRevision)     // optimistic lock
await kv.keys()                               // async iterator of keys
await kv.history({ key })                     // async iterator of KvEntry
await kv.watch({ key? })                      // async iterator of changes
await kv.status()                             // KvStatus
await kv.destroy()                            // delete bucket
```

**KvEntry:**

```ts
entry.key          // string
entry.value        // Uint8Array
entry.string()     // decoded as UTF-8 string
entry.json<T>()    // parsed as JSON
entry.revision     // number — use for optimistic locking
entry.operation    // 'PUT' | 'DEL' | 'PURGE'
entry.created      // Date
```

---

## useObj(bucket, opts?)

Opens a JetStream Object Store bucket. Results are cached per bucket name within the process lifetime.

```ts
function useObj(bucket: string, opts?: Partial<ObjectStoreOptions>): Promise<ObjectStore>
```

| Parameter | Type | Description |
|---|---|---|
| `bucket` | `string` | Bucket name |
| `opts` | `Partial<ObjectStoreOptions>` | Options applied only on first open (creates bucket if missing) |

**Options:**

| Field | Type | Description |
|---|---|---|
| `storage` | `'file' \| 'memory'` | Storage backend. Default: `'file'` |
| `replicas` | `number` | Replication factor. Default: 1 |
| `max_chunk_size` | `number` | Chunk size in bytes. Default: 131072 (128 KB) |
| `ttl` | `number` | Entry TTL in ms. Default: none |
| `description` | `string` | Human-readable description |

**ObjectStore methods:**

```ts
const obs = await useObj('uploads')

await obs.put(meta, data)     // meta: ObjectStoreMeta, data: Uint8Array | ReadableStream
await obs.get(name)           // ObjectResult | null
await obs.info(name)          // ObjectInfo | null
await obs.delete(name)        // void
await obs.list()              // async iterator of ObjectInfo
await obs.watch()             // async iterator of ObjectWatchInfo
await obs.status()            // ObjectStoreStatus
await obs.destroy()           // delete bucket and all objects
```

**ObjectStoreMeta:**

```ts
{
  name: string                // required — object key
  description?: string
  headers?: MsgHdrs
  options?: { link?: ObjectStoreLink }
}
```

**ObjectResult:**

```ts
result.info          // ObjectInfo
result.data          // ReadableStream<Uint8Array>
```

---

## jsPublish(subject, payload, opts?)

Publish a message to a JetStream subject with JSON encoding, retry, and optional deduplication.

```ts
// Typed overload (when subject is declared in NatsEvents)
function jsPublish<S extends keyof NatsEvents>(
  subject: S,
  payload: NatsEvents[S],
  opts?: PublishOpts,
): Promise<void>

// Untyped overload (any subject)
function jsPublish(
  subject: string,
  payload: Record<string, unknown> | unknown[] | string | number | boolean | null,
  opts?: PublishOpts,
): Promise<void>
```

**PublishOpts:**

| Field | Type | Default | Description |
|---|---|---|---|
| `msgId` | `string` | — | Idempotency key. Sets `Nats-Msg-Id` header. Dedup window is per-stream. Always wins over a `Nats-Msg-Id` key in `headers`. |
| `timeout` | `number` | `5000` | PubAck timeout in ms |
| `retries` | `number` | `3` | Max retry attempts on failure |
| `retryDelay` | `number` | `200` | Initial retry delay in ms (doubles each attempt) |
| `traceId` | `string` | — | Sets the `X-Trace-Id` header. Applied after `headers`, so it takes precedence over a `X-Trace-Id` key in `headers`. |
| `correlationId` | `string` | — | Sets the `X-Correlation-Id` header. Same precedence as `traceId`. |
| `headers` | `Record<string, string>` | — | Custom NATS message headers. Applied first — `traceId`, `correlationId`, and `msgId` all override conflicting keys. |

Throws after all retries are exhausted.

**Forwarding tracing headers:**

```ts
// server/api/orders.post.ts
export default defineEventHandler(async (event) => {
  const traceId = getRequestHeader(event, 'x-trace-id') ?? crypto.randomUUID()

  await jsPublish('orders.created', { id: '123' }, {
    msgId: '123',
    traceId,             // sets X-Trace-Id
    correlationId: traceId,  // sets X-Correlation-Id
  })

  return { ok: true }
})
```

Consumers receive the headers on the `JsMsg` object:

```ts
defineNatsConsumer({
  stream: 'ORDERS',
  durable: 'billing',
  handler(msg) {
    const traceId = msg.headers?.get('X-Trace-Id')
    // ...
  },
})
```

---

## corePublish(subject, payload)

Publish a core NATS message — fire-and-forget, no PubAck, no durability guarantee.

```ts
function corePublish(
  subject: string,
  payload: Record<string, unknown> | unknown[] | string | number | boolean | null,
): void
```

Use for metrics, ephemeral events, or any case where JetStream PubAck latency is unacceptable. Messages are not persisted and will be lost if no subscriber is listening at delivery time.

---

## defineNatsConsumer(opts)

Register and start a durable pull consumer. Requires `NUXT_NATS_WORKERS=true` — returns a no-op otherwise.

```ts
function defineNatsConsumer<T = unknown>(opts: NatsConsumerOptions<T>): ActiveConsumer
```

**NatsConsumerOptions:**

| Field | Type | Default | Description |
|---|---|---|---|
| `stream` | `string` | required | Stream name |
| `durable` | `string` | required | Durable consumer name (must exist on NATS server) |
| `filterSubjects` | `string[]` | — | Subject filters (subset of stream subjects) |
| `ackWait` | `number` | `30_000` | Ms before unacked message is redelivered |
| `maxDeliver` | `number` | `5` | Max delivery attempts (1 original + N-1 redeliveries) before DLQ routing |
| `backoff` | `number[]` | — | Per-redelivery nak delay in ms. `backoff[0]` applies after the 1st failure, `backoff[1]` after the 2nd, etc. Last entry is reused for all subsequent failures. |
| `deadLetterSubject` | `string` | — | JetStream subject for unprocessable messages. Must be covered by a stream. |
| `handler` | `(msg: JsMsg, payload: T) => Promise<void>` | required | Message handler |

**ActiveConsumer:**

```ts
interface ActiveConsumer {
  stop(): void   // gracefully stops the consumer loop
}
```

---

## stopAllConsumers()

Stop all consumers registered in the current process. Called automatically during graceful shutdown.

```ts
function stopAllConsumers(): void
```

---

## NatsEvents (interface)

Empty interface exported from `nuxt-nats`. Augment it in your application to enable typed subjects on `jsPublish`.

```ts
// types/nats.d.ts
declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': { id: string; total: number }
  }
}
```

See [Typed Events guide](./guides/typed-events.md) for full usage.

---

## Health endpoint

```
GET /api/_nats/health   (path configurable via nats.health.endpoint)
```

**Response — connected:**

```json
{
  "connected": true,
  "status": "ok",
  "server": "nats://localhost:4222",
  "rttMs": 1,
  "jetstream": {
    "available": true,
    "streams": 3,
    "consumers": 7,
    "memory": 0,
    "storage": 204800
  }
}
```

**Response — disconnected:**

```json
{
  "connected": false,
  "status": "disconnected"
}
```
