import type { JsMsg, OrderedConsumerOptions } from '@nats-io/jetstream'
import { useJetStream } from './useJetStream'

export interface EphemeralConsumerOptions {
  /** JetStream stream name. */
  stream: string
  /** Subject filter(s) for the ordered consumer. */
  filterSubjects: string[]
  /**
   * Called for each message. Return true to stop the consumer (message matched),
   * false/void to continue consuming.
   */
  onMessage: (msg: JsMsg) => Promise<boolean | void> | boolean | void
  /** Total wait timeout in ms. Default: 30_000 */
  timeoutMs?: number
  /** Called when the timeout fires before a matching message is found. */
  onTimeout?: () => Promise<void> | void
  /** Called when the client disconnects before a matching message is found. */
  onDisconnect?: () => Promise<void> | void
}

export interface EphemeralConsumerHandle {
  /** Stop consuming and release the consumer. Idempotent. */
  stop: () => void
}

/**
 * Creates an ephemeral ordered JetStream consumer scoped to a single request.
 * Handles timeout and client-disconnect cleanup automatically.
 *
 * Returns a handle with a `stop()` method. Wire it to your SSE stream's `onClosed`
 * callback so the consumer is released when the client disconnects.
 *
 * @example
 *   const handle = await useEphemeralConsumer({
 *     stream: 'DOCUMENTS',
 *     filterSubjects: ['tenant.v1.assessment.scored'],
 *     timeoutMs: 30_000,
 *     onMessage: async (msg) => {
 *       const payload = JSON.parse(new TextDecoder().decode(msg.data))
 *       if (payload.submission_id !== submissionId) return false
 *       msg.ack()
 *       await stream.push({ event: 'scored', data: JSON.stringify(payload) })
 *       await stream.close()
 *       return true  // stop consuming
 *     },
 *     onTimeout: async () => {
 *       await stream.push({ event: 'timeout', data: '{}' })
 *       await stream.close()
 *     },
 *   })
 *   stream.onClosed(() => handle.stop())
 *   return stream.send()
 */
export async function useEphemeralConsumer(opts: EphemeralConsumerOptions): Promise<EphemeralConsumerHandle> {
  const { stream, filterSubjects, onMessage, timeoutMs = 30_000, onTimeout, onDisconnect } = opts

  const js = useJetStream()

  const consumerOpts: Partial<OrderedConsumerOptions> = { filter_subjects: filterSubjects }
  const consumer = await js.consumers.get(stream, consumerOpts)
  const messages = await consumer.consume()

  let stopped = false

  function stop() {
    if (stopped) return
    stopped = true
    messages.stop()
  }

  const timer = setTimeout(async () => {
    stop()
    try { await onTimeout?.() }
    catch { /* caller-provided callback errors must not bubble */ }
  }, timeoutMs)

  // Async message loop — non-blocking, runs for the lifetime of the consumer
  ;(async () => {
    try {
      for await (const msg of messages) {
        if (stopped) break
        try {
          const done = await onMessage(msg)
          if (done) {
            clearTimeout(timer)
            stop()
            break
          }
        }
        catch {
          // Per-message errors must not kill the consumer loop — ack and continue
          msg.ack()
        }
      }
    }
    catch {
      // ConsumerMessages iterator throws on forced stop — expected, ignore
    }
  })()

  return {
    stop() {
      clearTimeout(timer)
      const wasDisconnect = !stopped
      stop()
      if (wasDisconnect) {
        try { onDisconnect?.() }
        catch { /* ignore */ }
      }
    },
  }
}
