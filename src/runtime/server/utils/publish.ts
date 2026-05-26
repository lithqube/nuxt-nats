import { headers } from '@nats-io/nats-core'
import type { JetStreamPublishOptions } from '@nats-io/jetstream'
import { useJetStream } from './useJetStream'
import { useNats } from './useNats'

// Extend this interface in your app to get typed subjects:
//   declare module 'nuxt-nats' { interface NatsEvents { 'user.created': { id: string } } }
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NatsEvents {}

type AnyPayload = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface PublishOpts {
  /** Idempotency key — sets Nats-Msg-Id header. Dedup window is per-stream (default: 2 min). */
  msgId?: string
  /** Timeout in ms for JetStream PubAck. Default: 5000 */
  timeout?: number
  /** Number of retries on publish failure. Default: 3 */
  retries?: number
  /** Initial retry delay in ms (doubles each attempt). Default: 200 */
  retryDelay?: number
  /** Custom NATS message headers (e.g. tracing headers forwarded to consumers). */
  headers?: Record<string, string>
}

/**
 * Publish a message to a JetStream subject with JSON encoding and retry.
 * Typed when the subject is declared in NatsEvents.
 *
 * @example
 *   await jsPublish('user.created', { id: '123' }, { msgId: '123' })
 *   await jsPublish('user.created', { id: '123' }, { msgId: '123', headers: { 'X-Trace-Id': traceId } })
 */
export async function jsPublish<S extends keyof NatsEvents>(
  subject: S,
  payload: NatsEvents[S],
  opts?: PublishOpts,
): Promise<void>
export async function jsPublish(
  subject: string,
  payload: AnyPayload,
  opts?: PublishOpts,
): Promise<void>
export async function jsPublish(
  subject: string,
  payload: AnyPayload,
  opts: PublishOpts = {},
): Promise<void> {
  const { msgId, timeout = 5000, retries = 3, retryDelay = 200, headers: extraHeaders } = opts
  const js = useJetStream()
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const encoded = new TextEncoder().encode(data)

  const pubOpts: Partial<JetStreamPublishOptions> = { timeout }
  if (msgId || extraHeaders) {
    const h = headers()
    if (msgId) h.set('Nats-Msg-Id', msgId)
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) h.set(k, v)
    }
    pubOpts.headers = h
  }

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await js.publish(subject, encoded, pubOpts)
      return
    }
    catch (err) {
      lastErr = err
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, retryDelay * 2 ** attempt))
      }
    }
  }
  throw new Error(`[nuxt-nats] jsPublish failed after ${retries + 1} attempts on "${subject}": ${lastErr}`)
}

/**
 * Publish a core NATS message — fire-and-forget, no PubAck, no durability.
 * Use for metrics, ephemeral events, or when JetStream overhead isn't needed.
 */
export function corePublish(subject: string, payload: AnyPayload): void {
  const nc = useNats()
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  nc.publish(subject, new TextEncoder().encode(data))
}
