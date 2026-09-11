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

```ts
const js = useJetStream()

// Direct publish (no retry)
await js.publish('orders.created', new TextEncoder().encode(JSON.stringify(data)))

// Consumer access
const consumer = await js.consumers.get('ORDERS', 'billing')
const iter = await consumer.consume()
```

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
| `onReconnect` | Client recovers from a disconnect. Fires once per outage: the first `reconnect` status after a `disconnect` is forwarded, and repeat `reconnect` statuses with no `disconnect` in between are dropped (the client can emit one per retry attempt, nats.js#423) |
| `onDisconnect` | Client loses its connection to a server. Fires on every `disconnect` status |

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

Register and start a durable pull consumer. Requires `NUXT_NATS_WORKERS=true` — logs a skip warning and returns a no-op handle otherwise. Call it from a Nitro plugin (`server/plugins/`); see the [Consumers guide](./guides/consumers.md).

```ts
function defineNatsConsumer<T = unknown>(opts: NatsConsumerOptions<T>): ActiveConsumer
```

**NatsConsumerOptions:**

| Field | Type | Default | Description |
|---|---|---|---|
| `stream` | `string` | required | Stream name |
| `durable` | `string` | required | Durable consumer name. Must already exist unless `provision` is `'startup'` |
| `provision` | `'startup' \| 'never'` | `'never'` | `'never'` binds to an existing durable, and reports a missing one once with the `nats consumer add` command that creates it. `'startup'` creates the durable from this config when it is missing |
| `filterSubjects` | `string[]` | — | The durable's subject filter. Written only when this call creates the durable; against an existing durable a different value is logged as a mismatch and the live filter wins |
| `ackPolicy` | `'explicit' \| 'none' \| 'all'` | `'explicit'` | Written only when this call creates the durable |
| `ackWait` | `number` | `30_000` | Ms. Sets the `msg.working()` heartbeat interval (`ackWait / 2`), and the durable's `ack_wait` when this call creates it |
| `maxDeliver` | `number` | `5` | With `deadLetterSubject` set, the delivery attempt on which a message is routed there. Also the durable's `max_deliver` when this call creates it; an existing durable's `max_deliver` must be at least this (or unlimited), or the server stops redelivering first |
| `backoff` | `number[]` | — | Per-redelivery nak delay in ms. `backoff[0]` applies after the 1st failure, `backoff[1]` after the 2nd, etc. Last entry is reused for all subsequent failures. Also written to the durable when this call creates it, in which case the server requires `maxDeliver` to exceed `backoff.length` |
| `deadLetterSubject` | `string` | — | JetStream subject for unprocessable messages. Must be covered by a stream. Without it, a message that exhausts the durable's `max_deliver` is dropped by the server, leaving only an advisory (see [`defineDeadLetterConsumer`](#definedeadletterconsumeropts)) |
| `handler` | `(msg: JsMsg, payload: T) => Promise<void>` | required | Message handler. `payload` is `JSON.parse(msg.string())`, or the raw string when that fails |

`NatsConsumerOptions` is auto-imported as a type in `server/`.

**ActiveConsumer:**

```ts
interface ActiveConsumer {
  stop(): void   // gracefully stops the consumer loop
}
```

---

## Module option: `nats.consumers`

Declares consumers in `nuxt.config` instead of calling `defineNatsConsumer()`. At build time the module compiles the array into a generated Nitro plugin that statically imports each handler and passes the entry to `defineNatsConsumer()`, so the same fields, defaults and `NUXT_NATS_WORKERS` gate apply.

```ts
nats: {
  consumers: [
    {
      stream: 'ORDERS',
      durable: 'billing',
      filterSubjects: ['orders.created'],
      provision: 'startup',
      handler: 'workers/billing',   // relative to server/, or absolute
    },
  ],
}
```

`ConsumerDefinition` has the `NatsConsumerOptions` fields, except that `handler` is a module path whose default export is the `(msg, payload) => Promise<void>` handler. The build fails when an entry is missing `stream`, `durable` or `handler`, when two entries share a stream and durable, or when `stream`, `durable`, `filterSubjects` or `deadLetterSubject` contain a single quote, backslash or newline. The array is not copied into `runtimeConfig`.

---

## stopAllConsumers()

Stop all consumers registered in the current process. Called automatically during graceful shutdown.

```ts
function stopAllConsumers(): void
```

---

## defineDeadLetterConsumer(opts)

Consume dead-letter advisories durably. NATS has no dead-letter queue: when a message exhausts `max_deliver` the server drops it and publishes an advisory, and `msg.term()` publishes another. This registers a durable consumer (through `defineNatsConsumer`, so the `NUXT_NATS_WORKERS` gate applies) on a stream you provision over both advisory subjects, and hands your handler a normalised event with the original message fetched by sequence.

```ts
function defineDeadLetterConsumer(opts: DeadLetterConsumerOptions): ActiveConsumer
```

**DeadLetterConsumerOptions:**

| Field | Type | Default | Description |
|---|---|---|---|
| `stream` | `string` | required | The stream capturing the advisory subjects — not the stream your messages are on. Provision it over `ADVISORY_MAX_DELIVERIES` and `ADVISORY_MSG_TERMINATED` |
| `durable` | `string` | required | Durable consumer name on that stream |
| `provision` | `'startup' \| 'never'` | `'never'` | As for `defineNatsConsumer` |
| `ackWait` | `number` | `30_000` | Ms |
| `recoverMessage` | `boolean` | `true` | Fetch the original message by sequence before calling the handler. Set `false` to skip the round trip when the metadata is enough |
| `onDeadLetter` | `(event: DeadLetterEvent, msg: JsMsg) => Promise<void>` | required | Called once per advisory. Ack `msg` yourself; a handler that throws is nak'd and redelivered |

There is deliberately no `deadLetterSubject` here: routing a failing dead-letter handler into another dead-letter subject builds a loop.

**DeadLetterEvent:**

```ts
interface DeadLetterEvent {
  kind: 'max_deliver' | 'terminated' | 'unknown'   // from the advisory's `type`
  stream: string              // the stream the dead message lived on, not the advisory stream
  consumer: string
  streamSeq: number
  deliveries: number
  consumerSeq?: number        // terminated advisories only
  reason?: string             // the msg.term(reason) string, terminated advisories only
  advisory: MaxDeliverAdvisory | TerminatedAdvisory
  message: StoredMsg | null   // null when recovery is off, the message aged out, or the fetch failed
}
```

When the fetch fails, typically because the message has aged out of a stream whose `max_age` is shorter than the advisory stream's, a warning is logged and the handler still runs with `message: null`.

**Also exported** (auto-imported in `server/`):

| Name | Kind | Description |
|---|---|---|
| `ADVISORY_MAX_DELIVERIES` | constant | `'$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>'` |
| `ADVISORY_MSG_TERMINATED` | constant | `'$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>'` |
| `toDeadLetterEvent(advisory)` | function | The pure advisory-to-event mapping `defineDeadLetterConsumer` uses, without `message` |
| `MaxDeliverAdvisory` | type | `io.nats.jetstream.advisory.v1.max_deliver` payload. Has no `consumer_seq` |
| `TerminatedAdvisory` | type | `io.nats.jetstream.advisory.v1.terminated` payload, with `consumer_seq` and `reason` |
| `DeadLetterEvent`, `DeadLetterConsumerOptions`, `DeadLetterKind` | type | As above |

See the [dead-letter section of the Consumers guide](./guides/consumers.md#dead-letter-queue-dlq) for the stream to provision and the two mistakes this avoids.

---

## defineNatsAgent(opts)

Register and serve a [Synadia Agent Protocol](./guides/agents.md) agent over the module's NATS connection — discoverable via `$SRV.PING.agents` and promptable by any protocol-compliant caller. Runs **only when `NUXT_NATS_WORKERS=true`** (a logged no-op otherwise), and waits for the connection internally so it is safe to call from any server plugin regardless of plugin order. Stopped automatically on shutdown.

```ts
function defineNatsAgent(opts: NatsAgentOptions): NatsAgentHandle
```

**`NatsAgentOptions`:**

| Option | Type | Default | Notes |
|---|---|---|---|
| `agent` | `string` | — | `metadata.agent` — lowercase `a-z0-9-_`, identity tuple. |
| `owner` | `string` | — | `metadata.owner` — tenant / account namespace. |
| `name` | `string` | — | Instance name (5th subject token, e.g. a session or node id). |
| `onPrompt` | `PromptHandler` | — | `(envelope, response) => …`. Stream chunks with `response.send()`; ask the caller mid-stream with `response.ask(prompt, { timeoutMs })`. The SDK emits the leading `ack` and zero-byte terminator. |
| `subjectToken` | `string` | `agent` | Override the subject's 3rd token (e.g. `cc` for `claude-code`). |
| `description` | `string` | — | Service description surfaced by `nats micro info`. |
| `version` | `string` | — | Harness semver advertised as `service.version`. |
| `heartbeatIntervalS` | `number` | `30` | Heartbeat cadence in seconds. |
| `attachmentsOk` | `boolean` | `true` | Whether the prompt endpoint accepts attachments. |
| `maxPayload` | `string` | broker-negotiated | Omit to advertise `nc.info.max_payload`; an over-large override is clamped to the server limit. |
| `extraMetadata` | `Record<string, string>` | — | Extra metadata merged into the service metadata. |
| `extraEndpoints` | `AgentServiceExtraEndpoint[]` | — | Custom controller endpoints (`spawn`/`stop`/`list`); subjects advertised verbatim. |

**`NatsAgentHandle`:**

```ts
interface NatsAgentHandle {
  stop: () => Promise<void>                                          // idempotent; deregisters and drops from the registry
  status: () => 'starting' | 'running' | 'stopped' | 'error'
  identity: { agent: string, owner: string, name: string }
}
```

See the [Agent Fabric guide](./guides/agents.md) for streaming, human-in-the-loop, and controller patterns.

---

## useAgents()

Caller-side client for the Synadia Agent Protocol — discover and prompt agents on the bus over the module's connection. Returns a process-wide cached [`Agents`](https://github.com/synadia-ai/synadia-agent-sdk-docs) client (one heartbeat subscription is reused). Throws if the connection is not yet established. Closed automatically on shutdown.

```ts
function useAgents(): Agents
```

```ts
const agents = useAgents()
const found = await agents.discover()
for await (const msg of await found[0]!.prompt('summarize the incident')) {
  if (msg.type === 'response') process.stdout.write(msg.text)
}
```

---

## getAgentStatuses()

Snapshot of agents registered in the current process — used by the health endpoint.

```ts
function getAgentStatuses(): Array<{ agent: string, owner: string, name: string, status: string }>
```

---

## stopAllAgents()

Stop all registered agents (heartbeats + endpoints). Called automatically during graceful shutdown, before `stopAllConsumers()` and `nc.drain()`.

```ts
function stopAllAgents(): Promise<void>
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
  },
  "agents": [
    { "agent": "nuxt-assistant", "owner": "acme", "name": "web-1", "status": "running" }
  ]
}
```

The `agents` array is present only when one or more agents are registered in the process (see [`defineNatsAgent`](#definenatsagentopts)).

**Response — disconnected:**

```json
{
  "connected": false,
  "status": "disconnected"
}
```
