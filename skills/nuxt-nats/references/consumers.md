# Consuming with nuxt-nats

Three shapes: durable pull workers (`defineNatsConsumer`, or the declarative `nats.consumers` option), a dead-letter consumer over the server's advisories (`defineDeadLetterConsumer`), and request-scoped ordered consumers for SSE (`useEphemeralConsumer`).

## The worker gate: read this first

**Durable consumers and agents run only when `NUXT_NATS_WORKERS=true`.** Without it the app boots, publishes and can create ephemeral consumers, but starts no durable consumers and logs a skip warning. This is deliberate: long-lived pull loops do not belong on serverless or edge. If a consumer "never fires", check this before anything else. The recommended topology is a serverless publisher plus a separate persistent worker process:

```bash
NUXT_NATS_WORKERS=true node .output/server/index.mjs
```

## `defineNatsConsumer`: durable pull worker

Call it from a Nitro **server plugin** (`server/plugins/**`). Nitro does **not** scan `server/workers/`, so a call placed there never runs.

```ts
export default defineNitroPlugin(() => {
  defineNatsConsumer({
    stream: 'ORDERS',
    durable: 'order-processor',
    ackWait: 30_000,                   // ms
    maxDeliver: 5,
    backoff: [1_000, 5_000, 15_000],   // ms, per redelivery; the last entry repeats
    deadLetterSubject: 'dlq.orders',   // must be covered by a stream
    async handler(msg, payload) {      // (JsMsg, parsed payload). NOT (data, msg)
      await processOrder(payload)
      msg.ack()
    },
  })
})
```

- `payload` is `JSON.parse(msg.string())`, or the raw string when the body is not JSON.
- **The handler must ack.** The loop does not ack when the handler returns. Call `msg.ack()`, or `msg.term(reason)` / `msg.nak(delayMs)`. If the handler throws, the loop logs the error and `msg.nak()`s with `backoff[deliveryCount - 1]` (or no delay when `backoff` is unset). A handler that resolves without acking is redelivered after `ackWait`.
- Each message gets a `msg.working()` heartbeat every `ackWait / 2`, so slow handlers are not redelivered. The loop pulls one message at a time (`max_messages: 1`).
- **Binds, does not enforce.** `provision: 'never'` (default) binds an existing durable; if it is missing the module logs the `nats consumer add` command once and retries. `provision: 'startup'` creates it from your options when absent. Against an existing durable, `filterSubjects`, `ackWait` and the rest are not applied; a differing filter is logged as a mismatch and the live filter wins. A durable's config is immutable server-side, so changing it means deleting and recreating the durable.
- `stop()` on the returned handle stops the loop; shutdown stops consumers before the connection drains.

### Ack rules that matter

- `msg.nak(delayMs)` for a transient failure. A **bare `msg.nak()` redelivers immediately** and can burn every `maxDeliver` attempt in milliseconds, so pass a delay for "not ready yet".
- `msg.term(reason)` for a poison message you will never process. It stops redelivery and records the reason in the `MSG_TERMINATED` advisory.
- `msg.ack()` to drop something unusable without redelivery.
- Do not call more than one ack method per message. If you ack and then throw, the ack stands.
- JetStream is at-least-once: keep a processed table keyed on `Nats-Msg-Id` and skip repeats. Reject a message with no `Nats-Msg-Id` via `term()` if you rely on it, since redelivery can never add the header.

## Declarative consumers: `nats.consumers`

The same options in `nuxt.config`, with `handler` as a module path (relative to `server/`, or absolute) default-exporting `(msg, payload) => Promise<void>`. The module compiles them into a generated plugin that imports each handler statically, which is what makes a file under `server/workers/` work:

```ts
nats: {
  consumers: [
    { stream: 'ORDERS', durable: 'billing', filterSubjects: ['orders.created'], provision: 'startup', handler: 'workers/billing' },
  ],
}
```

The build fails on a missing `stream`, `durable` or `handler`, or a duplicate stream + durable. A handler path that does not resolve is only a build warning, then every process crashes at startup with `ERR_MODULE_NOT_FOUND`.

## Dead letters: there is no DLQ in NATS

`maxDeliver` means **retry, then stop**. The server discards the message from the consumer's point of view and publishes a `MAX_DELIVERIES` advisory. Two tools:

1. **`deadLetterSubject` on your own consumer.** On the `maxDeliver`-th delivery the module publishes the message to that subject with `jsPublish` (durable) and then `msg.term(reason)`s it, instead of calling the handler. The subject must be covered by a stream.
2. **`defineDeadLetterConsumer()`** for everything else, including consumers you do not own. It consumes the advisories from a stream you provision over `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>` and `$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>` (constants `ADVISORY_MAX_DELIVERIES` and `ADVISORY_MSG_TERMINATED`):

```ts
export default defineNitroPlugin(() => {
  defineDeadLetterConsumer({
    stream: 'JS_ADVISORY',            // the advisory stream, not your message stream
    durable: 'dead-letter-handler',
    async onDeadLetter(event, msg) {  // NOT `handler`
      await recordDeadLetter({
        kind: event.kind,             // 'max_deliver' | 'terminated'
        stream: event.stream, consumer: event.consumer, seq: event.streamSeq,
        reason: event.reason,         // terminated advisories only
        body: event.message?.data,    // null when the message aged out (expected)
      })
      msg.ack()                       // you ack
    },
  })
})
```

Avoid two mistakes: do not subscribe to advisories with core NATS (fire-and-forget, lost during a restart), and do not use the account-wide `$JS.EVENT.ADVISORY.>` firehose (it carries an audit advisory for every JetStream API call). There is deliberately no `deadLetterSubject` on a dead-letter consumer: a failing handler would loop.

## `useEphemeralConsumer`: SSE and "wait for this event"

A request-scoped **ordered** consumer with timeout and disconnect cleanup. `onMessage` receives the raw `JsMsg` (decode it yourself) and returns `true` to stop:

```ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const stream = createEventStream(event)
  const handle = await useEphemeralConsumer({
    stream: 'ORDERS',
    filterSubjects: ['orders.*.shipped'],
    timeoutMs: 30_000,
    async onMessage(msg) {
      const payload = JSON.parse(new TextDecoder().decode(msg.data))
      if (payload.id !== id) return false          // keep waiting
      await stream.push({ event: 'shipped', data: JSON.stringify(payload) })
      await stream.close()
      return true
    },
    onTimeout: async () => { await stream.push({ event: 'timeout', data: '{}' }); await stream.close() },
  })
  stream.onClosed(() => handle.stop())             // client went away
  return stream.send()
})
```

Never create a durable consumer per request. Ordered consumers carry no ack state; per-message errors in `onMessage` are swallowed and the loop continues. Client 3.5 keeps `inactive_threshold` across ordered-consumer resets.
