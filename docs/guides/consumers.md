# Consumers

A JetStream consumer is a stateful cursor into a stream. It tracks which messages have been delivered and acknowledged, enabling durable, exactly-once processing across process restarts.

## defineNatsConsumer

```ts
// server/workers/billing.ts
defineNatsConsumer({
  stream: 'ORDERS',
  durable: 'billing',

  // Optional filters (subset of the stream's subjects)
  filterSubjects: ['orders.paid', 'orders.refunded'],

  ackWait: 30_000,       // ms before unacked message is redelivered. Default: 30s
  maxDeliver: 5,         // max redelivery attempts before DLQ. Default: 5
  backoff: [1000, 5000, 15_000, 60_000],  // per-redelivery delays in ms

  deadLetterSubject: 'orders.dlq',  // subject for unprocessable messages

  async handler(msg, payload) {
    await processBillingEvent(payload)
    msg.ack()
  },
})
```

### Enabling consumers

Consumers only start when `NUXT_NATS_WORKERS=true`:

```bash
NUXT_NATS_WORKERS=true node .output/server/index.mjs
```

Without this variable, `defineNatsConsumer` logs a warning and returns a no-op. This prevents long-lived consumers from starting in serverless environments. See [ADR-004](../adr/004-worker-guard.md).

## How handler invocation works

For each message pulled from the stream:

1. **DLQ check:** If `msg.info.deliveryCount >= maxDeliver` and `deadLetterSubject` is set, the message is published to the DLQ subject via `jsPublish` and `msg.term()` is called (permanently removes from stream). Handler is not called.

2. **Heartbeat timer:** A `setInterval` calls `msg.working()` every `ackWait / 2` ms while the handler runs. This resets the server-side ack timer, preventing redelivery for slow handlers.

3. **Handler call:** `await handler(msg, payload)` is called. `payload` is the result of `JSON.parse(msg.string())`, falling back to the raw string if JSON parsing fails.

4. **Error handling:** If the handler throws, `msg.nak(delay)` is called with the next backoff delay (if `backoff` is set), or plain `msg.nak()` otherwise. The error is logged.

5. **Cleanup:** The heartbeat timer is cleared in `finally`.

## Ack patterns

The handler receives the raw `JsMsg` — call the appropriate ack method before returning:

```ts
msg.ack()       // processed successfully — remove from pending
msg.nak()       // processing failed — redeliver after ackWait / backoff
msg.term()      // permanently reject — do not redeliver (use for poison messages)
msg.working()   // extend ackWait — called automatically by the heartbeat timer
```

If your handler calls `msg.ack()` but does not return (throws after ack), that is fine — the ack is already sent. Avoid calling multiple ack methods on the same message.

## Dead-letter queue (DLQ)

When a message exceeds `maxDeliver` attempts:

1. The module publishes a JSON envelope to `deadLetterSubject`:

```json
{
  "originalSubject": "orders.paid",
  "deliveryCount": 4,
  "data": "{\"id\":\"123\",\"total\":99.99}"
}
```

2. `msg.term()` is called — the message is permanently removed from the consumer.

To process DLQ messages, create a separate consumer on a stream that captures `orders.dlq`:

```ts
defineNatsConsumer({
  stream: 'DLQ',
  durable: 'dlq-processor',
  filterSubjects: ['orders.dlq'],
  maxDeliver: 1,  // don't retry DLQ messages

  async handler(msg, payload) {
    await alertOperations(payload)
    msg.ack()
  },
})
```

## Consumer provisioning

`defineNatsConsumer` expects the consumer to already exist on the NATS server. Create it via CLI:

```bash
nats consumer add ORDERS billing \
  --ack explicit \
  --deliver all \
  --max-deliver 5 \
  --ack-wait 30s \
  --filter 'orders.paid'
```

Or create it programmatically in a setup script:

```ts
const jsm = useJetStreamManager()

await jsm.consumers.add('ORDERS', {
  durable_name: 'billing',
  ack_policy: 'explicit',
  deliver_policy: 'all',
  max_deliver: 5,
  ack_wait: 30_000_000_000,   // nanoseconds
  filter_subjects: ['orders.paid', 'orders.refunded'],
})
```

## Stopping consumers

Each `defineNatsConsumer` call returns an `ActiveConsumer` handle:

```ts
const handle = defineNatsConsumer({ ... })

// Later, to stop gracefully:
handle.stop()
```

`stopAllConsumers()` stops all registered consumers — called automatically on shutdown.

## Scaling workers

Multiple worker processes can consume from the same durable consumer — NATS distributes messages across them:

```bash
# Start 3 worker processes
for i in 1 2 3; do
  NUXT_NATS_WORKERS=true node .output/server/index.mjs &
done
```

All three processes connect to the same `billing` durable consumer. NATS delivers each message to exactly one of them.

## Operational monitoring

### Diagnosing consumer health

```bash
# Quick overview — shows pending, ack-pending, and redelivery counts
nats consumer report ORDERS

# Detailed info for a single consumer
nats consumer info ORDERS billing

# Key fields to watch:
# Num Pending       — messages in stream not yet delivered (consumer lag)
# Num Ack Pending   — delivered but unacked. If equals MaxAckPending, consumer is blocked.
# Num Redelivered   — high value means handlers are failing or timing out
```

### JetStream advisory subjects

NATS publishes real-time events on `$JS.EVENT.ADVISORY.>`. Subscribe to these for alerting:

```bash
# Monitor max-delivery exhaustions (messages going to DLQ)
nats sub '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.ORDERS.billing'

# Monitor all advisories
nats sub '$JS.EVENT.ADVISORY.>'
```

Wire advisory subscriptions in a worker plugin for application-level alerting:

```ts
// server/plugins/nats-advisories.ts
export default defineNitroPlugin(() => {
  const nc = useNats()

  nc.subscribe('$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>', {
    callback: (err, msg) => {
      if (err) return
      const advisory = JSON.parse(msg.string())
      console.error('[dlq-alert] max deliveries exceeded', {
        stream: advisory.stream,
        consumer: advisory.consumer,
        seq: advisory.stream_seq,
      })
      // Notify PagerDuty / Slack here
    },
  })
})
```

### Consumer lag alert

If `Num Pending` grows unbounded, processing is slower than the publish rate. Options:

1. Scale workers — run more instances with `NUXT_NATS_WORKERS=true`
2. Increase batch size — the module currently processes one message at a time (`max_messages: 1`). Use `useJetStream()` directly for custom batch consumers
3. Optimize the handler — reduce external call latency (DB queries, HTTP requests)

## Ephemeral consumers (SSE / request-scoped)

For SSE endpoints that wait for a single matching event, use `useEphemeralConsumer()`. It creates an ordered ephemeral consumer scoped to the request lifetime and handles three concerns automatically:

- **Timeout** — fires `onTimeout` when `timeoutMs` elapses
- **Client disconnect** — fires `onDisconnect` when `handle.stop()` is called before a match
- **Per-message errors** — caught and isolated; the loop continues to the next message

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
      if (payload.id !== id) return false    // not our order — keep waiting
      msg.ack()
      await stream.push({ event: 'shipped', data: JSON.stringify(payload) })
      await stream.close()
      return true                            // stop consuming
    },
    onTimeout: async () => {
      await stream.push({ event: 'timeout', data: '{}' })
      await stream.close()
    },
  })

  stream.onClosed(() => handle.stop())       // client disconnected before match
  return stream.send()
})
```

`handle.stop()` is idempotent — safe to call multiple times and from `onClosed`.

## Ordered consumers (advanced)

For event sourcing or read model rebuilds — ordered, ephemeral delivery from a specific sequence — access the JetStream client directly:

```ts
export default defineEventHandler(async () => {
  const js = useJetStream()

  const consumer = await js.consumers.get('ORDERS', {
    deliver_policy: 'by_start_sequence',
    opt_start_seq: 1,
    ack_policy: 'none',
    filter_subjects: ['orders.>'],
  })

  const iter = await consumer.consume()
  const events = []

  for await (const msg of iter) {
    events.push(JSON.parse(msg.string()))
    if (msg.info.pending === 0) break   // caught up
  }

  iter.stop()
  return events
})
```
