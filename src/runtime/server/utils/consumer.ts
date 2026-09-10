import { useJetStream, useJetStreamManager } from './useJetStream'
import { jsPublish } from './publish'
import type { JsMsg } from '@nats-io/jetstream'

const NANOS_PER_MS = 1_000_000

export interface NatsConsumerOptions<T = unknown> {
  stream: string
  durable: string
  /**
   * Subject filter(s) for the durable.
   *
   * Only has an effect when this call CREATES the consumer, i.e. `provision: 'startup'`
   * and the durable does not exist yet. A consumer's filter is server-side state; binding
   * to an existing durable cannot change it, and passing a different value here does not
   * re-filter what you receive.
   *
   * Before 0.1.0-beta.2 this field was accepted and never read at all, so a consumer could
   * declare one filter and silently receive another. It is now either applied at creation
   * or reported as a mismatch against the live durable.
   */
  filterSubjects?: string[]
  /** Ack policy, applied only when this call creates the consumer. Default: 'explicit' */
  ackPolicy?: 'explicit' | 'none' | 'all'
  /** ms. Drives the msg.working() heartbeat, and the durable's ack_wait at creation. Default: 30_000 */
  ackWait?: number
  /** Max redelivery attempts before routing to DLQ. Default: 5 */
  maxDeliver?: number
  /** Per-redelivery backoff delays in ms. */
  backoff?: number[]
  /** Subject to publish unprocessable messages. Required for DLQ to activate. */
  deadLetterSubject?: string
  /**
   * 'never'   — bind to an existing durable; never create one. Default.
   * 'startup' — create the durable from this config if it does not exist, then bind.
   *
   * Default is 'never' to match `StreamDefinition.provision` and the module's general
   * stance that provisioning belongs in IaC. Under 'never' a missing durable is reported
   * with an actionable error rather than retried silently forever.
   */
  provision?: 'startup' | 'never'
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
/** Thrown when `provision: 'never'` and the durable does not exist on the server. */
class ConsumerMissingError extends Error {
  constructor(stream: string, durable: string) {
    super(
      `[nuxt-nats] Consumer "${durable}" does not exist on stream "${stream}". `
      + `This module binds to durables, it does not create them unless you set `
      + `provision: 'startup'. Either create it in your provisioning step `
      + `(e.g. nats consumer add ${stream} ${durable} --pull --ack explicit), or pass `
      + `provision: 'startup' to defineNatsConsumer().`,
    )
    this.name = 'ConsumerMissingError'
  }
}

function sameSubjects(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((v, i) => v === right[i])
}

/**
 * Bring the server-side durable into a known state before binding to it.
 *
 * Two jobs, both of which used to be missing entirely:
 *
 *  1. Under `provision: 'startup'`, create the durable from the declared config. Without
 *     this, `filterSubjects`, `ackPolicy`, `ackWait` and `maxDeliver` were accepted by the
 *     API and applied to nothing, because `js.consumers.get()` binds to whatever the
 *     server already has.
 *  2. Under either mode, when the durable exists and the caller declared `filterSubjects`,
 *     compare them and report a mismatch. Silently receiving a different subject set than
 *     the one written in the code is the failure this guards.
 */
async function ensureConsumer(cfg: {
  stream: string
  durable: string
  filterSubjects?: string[]
  ackPolicy: 'explicit' | 'none' | 'all'
  ackWait: number
  maxDeliver: number
  backoff?: number[]
  provision: 'startup' | 'never'
}): Promise<void> {
  const jsm = useJetStreamManager()

  let existing: Awaited<ReturnType<typeof jsm.consumers.info>> | null = null
  try {
    existing = await jsm.consumers.info(cfg.stream, cfg.durable)
  }
  catch {
    // info() rejects when the durable does not exist; `existing` stays null.
  }

  if (!existing) {
    if (cfg.provision !== 'startup') {
      throw new ConsumerMissingError(cfg.stream, cfg.durable)
    }
    await jsm.consumers.add(cfg.stream, {
      durable_name: cfg.durable,
      ack_policy: cfg.ackPolicy as never,
      ack_wait: cfg.ackWait * NANOS_PER_MS,
      max_deliver: cfg.maxDeliver,
      ...(cfg.backoff?.length ? { backoff: cfg.backoff.map(ms => ms * NANOS_PER_MS) } : {}),
      ...(cfg.filterSubjects?.length
        ? cfg.filterSubjects.length === 1
          ? { filter_subject: cfg.filterSubjects[0] }
          : { filter_subjects: cfg.filterSubjects }
        : {}),
    } as never)
    console.log(`[nuxt-nats] Consumer "${cfg.durable}" created on stream "${cfg.stream}"`)
    return
  }

  if (cfg.filterSubjects?.length) {
    const liveCfg = existing.config as { filter_subject?: string, filter_subjects?: string[] }
    const live = liveCfg.filter_subjects
      ?? (liveCfg.filter_subject ? [liveCfg.filter_subject] : [])
    if (!sameSubjects(live, cfg.filterSubjects)) {
      console.error(
        `[nuxt-nats] Consumer "${cfg.durable}" filter mismatch. `
        + `Declared [${cfg.filterSubjects.join(', ')}] but the live durable filters `
        + `[${live.join(', ')}]. A consumer's filter is server-side state, so this call `
        + `will receive the LIVE set, not the declared one. Update the durable or the code.`,
      )
    }
  }
}

export function defineNatsConsumer<T = unknown>(opts: NatsConsumerOptions<T>): ActiveConsumer {
  if (process.env.NUXT_NATS_WORKERS !== 'true') {
    console.warn(`[nuxt-nats] Consumer "${opts.durable}" skipped — set NUXT_NATS_WORKERS=true to enable workers`)
    const noop: ActiveConsumer = { stop: () => {} }
    return noop
  }

  const {
    stream,
    durable,
    filterSubjects,
    ackPolicy = 'explicit',
    ackWait = 30_000,
    maxDeliver = 5,
    backoff,
    deadLetterSubject,
    provision = 'never',
    handler,
  } = opts

  let stopped = false
  let missingLogged = false
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
        await ensureConsumer({ stream, durable, filterSubjects, ackPolicy, ackWait, maxDeliver, backoff, provision })
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
          // A missing durable is a configuration fault, not a transient one. Log the
          // actionable message ONCE rather than repeating it every 5s forever, which is
          // what made this case read like a network blip in the logs.
          if (err instanceof ConsumerMissingError) {
            if (!missingLogged) {
              console.error(err.message)
              missingLogged = true
            }
          }
          else {
            console.error(`[nuxt-nats] Consumer "${durable}" loop error, retrying in 5s:`, err)
          }
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
