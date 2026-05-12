import { useJetStream } from './useJetStream'
import { jsPublish } from './publish'
import type { JsMsg } from '@nats-io/jetstream'

export interface NatsConsumerOptions<T = unknown> {
  stream: string
  durable: string
  filterSubjects?: string[]
  /** ms. Default: 30_000 */
  ackWait?: number
  /** Max redelivery attempts before routing to DLQ. Default: 5 */
  maxDeliver?: number
  /** Per-redelivery backoff delays in ms. */
  backoff?: number[]
  /** Subject to publish unprocessable messages. Required for DLQ to activate. */
  deadLetterSubject?: string
  handler: (msg: JsMsg, payload: T) => Promise<void>
}

interface ActiveConsumer {
  stop: () => void
}

const _activeConsumers: ActiveConsumer[] = []

/**
 * Register and start a durable pull consumer.
 * Only runs when NUXT_NATS_WORKERS=true to prevent long-lived consumers on serverless.
 *
 * Features:
 * - Auto-heartbeat via msg.working() to prevent redelivery on slow handlers
 * - DLQ routing when redelivery count exceeds maxDeliver
 * - Graceful stop via returned handle or global stopAllConsumers()
 *
 * @example
 *   defineNatsConsumer({
 *     stream: 'ORDERS',
 *     durable: 'billing',
 *     ackWait: 30_000,
 *     maxDeliver: 5,
 *     deadLetterSubject: 'orders.dlq',
 *     async handler(msg, payload) {
 *       await processOrder(payload)
 *       msg.ack()
 *     }
 *   })
 */
export function defineNatsConsumer<T = unknown>(opts: NatsConsumerOptions<T>): ActiveConsumer {
  if (process.env.NUXT_NATS_WORKERS !== 'true') {
    console.warn(`[nuxt-nats] Consumer "${opts.durable}" skipped — set NUXT_NATS_WORKERS=true to enable workers`)
    const noop: ActiveConsumer = { stop: () => {} }
    return noop
  }

  const {
    stream,
    durable,
    ackWait = 30_000,
    maxDeliver = 5,
    backoff,
    deadLetterSubject,
    handler,
  } = opts

  let stopped = false
  let iter: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof useJetStream>['consumers']['get']>>['consume']>> | undefined

  const stop = () => {
    stopped = true
    iter?.stop()
  }

  const handle: ActiveConsumer = { stop }
  _activeConsumers.push(handle)

  // Start async consumer loop
  ;(async () => {
    const js = useJetStream()

    while (!stopped) {
      try {
        const consumer = await js.consumers.get(stream, durable)
        // idle_heartbeat detects stale server-side subscriptions (network partition, server restart)
        iter = await consumer.consume({ max_messages: 1, idle_heartbeat: 5_000 })

        for await (const msg of iter) {
          if (stopped) {
            msg.nak()
            break
          }

          // Route to DLQ after maxDeliver attempts (deliveryCount is 1-based)
          if (msg.info.deliveryCount >= maxDeliver && deadLetterSubject) {
            console.warn(`[nuxt-nats] Message on "${msg.subject}" exceeded maxDeliver (${maxDeliver}), routing to DLQ: ${deadLetterSubject}`)
            try {
              await jsPublish(deadLetterSubject, {
                originalSubject: msg.subject,
                deliveryCount: msg.info.deliveryCount,
                data: msg.string(),
              })
            }
            catch (err) {
              console.error(`[nuxt-nats] Failed to publish to DLQ "${deadLetterSubject}":`, err)
            }
            msg.term()
            continue
          }

          // Heartbeat to prevent redelivery for long-running handlers
          const heartbeatTimer = setInterval(() => {
            try {
              msg.working()
            }
            catch {
              // msg may already be acked
            }
          }, Math.floor(ackWait / 2))

          let payload: T
          try {
            payload = JSON.parse(msg.string()) as T
          }
          catch {
            payload = msg.string() as unknown as T
          }

          try {
            await handler(msg, payload)
          }
          catch (err) {
            console.error(`[nuxt-nats] Consumer "${durable}" handler error:`, err)
            if (backoff?.length) {
              const idx = Math.min(msg.info.deliveryCount - 1, backoff.length - 1)
              msg.nak(backoff[idx])
            }
            else {
              msg.nak()
            }
          }
          finally {
            clearInterval(heartbeatTimer)
          }
        }
      }
      catch (err) {
        if (!stopped) {
          console.error(`[nuxt-nats] Consumer "${durable}" loop error, retrying in 5s:`, err)
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    }
  })()

  return handle
}

/**
 * Stop all running consumers. Called automatically on shutdown.
 */
export function stopAllConsumers() {
  for (const c of _activeConsumers) {
    c.stop()
  }
  _activeConsumers.length = 0
}
