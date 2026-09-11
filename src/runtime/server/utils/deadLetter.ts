import type { JsMsg, StoredMsg } from '@nats-io/jetstream'
import { useJetStreamManager } from './useJetStream'
import { defineNatsConsumer } from './consumer'

/**
 * Dead-letter handling for JetStream.
 *
 * NATS has no dead-letter queue. Not in any released server, and not in 2.15-RC:
 * `consumer.go` has no `dead_letter` field and there is no ADR proposing one. When a
 * message exhausts `max_deliver` the server drops it and publishes an advisory, and that
 * advisory is the only signal you get.
 *
 * Every team then rebuilds the same four moving parts, usually with the same two bugs:
 *
 *   1. Subscribing with `jsm.advisories()`. That subscribes to `$JS.EVENT.ADVISORY.>`,
 *      the whole-account firehose, which includes an API audit advisory published on
 *      EVERY JetStream API response, success or failure. Filter narrowly instead.
 *   2. Using a core NATS subscription. Advisories are fire-and-forget: anything published
 *      while the subscriber is redeploying, restarting or partitioned is gone for good.
 *      For a system whose invariant is "no message lost", the failure path cannot be the
 *      one ephemeral thing in the design.
 *
 * So this helper consumes advisories from a JetStream STREAM with a durable consumer. You
 * provision that stream yourself (see the `nats.streams` example in the README), because
 * capturing `$JS.EVENT.ADVISORY.>` subjects into a stream is a deployment decision, not
 * something a library should do behind your back.
 *
 * The advisory carries a stream sequence, not the message. Recovering the original body
 * is a second round trip, done here by default.
 */

/** Subject filter for max-deliver advisories. Stable from server 2.10 through 2.15-RC. */
export const ADVISORY_MAX_DELIVERIES = '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>'

/** Subject filter for explicit termination advisories (msg.term()). */
export const ADVISORY_MSG_TERMINATED = '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.>'

/**
 * `io.nats.jetstream.advisory.v1.max_deliver`.
 *
 * Hand-declared because `Advisory.data` is typed `unknown` in @nats-io/jetstream and no
 * payload types ship with the client. Field names mirror the server's
 * JSConsumerDeliveryExceededAdvisory struct verbatim.
 *
 * Note there is NO consumer_seq here, unlike the terminated advisory. Assuming symmetry
 * puts `undefined` in your audit trail.
 */
export interface MaxDeliverAdvisory {
  type: string
  id: string
  timestamp: string
  stream: string
  consumer: string
  stream_seq: number
  deliveries: number
  domain?: string
}

/** `io.nats.jetstream.advisory.v1.terminated`. Carries consumer_seq and the term() reason. */
export interface TerminatedAdvisory {
  type: string
  id: string
  timestamp: string
  stream: string
  consumer: string
  consumer_seq: number
  stream_seq: number
  deliveries: number
  reason?: string
  domain?: string
}

export type DeadLetterKind = 'max_deliver' | 'terminated' | 'unknown'

export interface DeadLetterEvent {
  kind: DeadLetterKind
  /** Stream the dead message lived on, NOT the advisory stream. */
  stream: string
  consumer: string
  streamSeq: number
  deliveries: number
  /** Present only on `terminated`. */
  consumerSeq?: number
  /** The reason passed to msg.term(reason), when there was one. */
  reason?: string
  advisory: MaxDeliverAdvisory | TerminatedAdvisory
  /**
   * The original message, fetched by sequence. Null when recovery is disabled, when the
   * message has already aged out of its stream, or when the fetch failed.
   */
  message: StoredMsg | null
}

/**
 * Normalise an advisory payload into a DeadLetterEvent.
 *
 * Pure and exported so the field mapping can be asserted directly. The `kind` comes from
 * the payload's `type` field rather than the subject, because a stream capturing both
 * advisory subjects delivers them through one consumer.
 */
export function toDeadLetterEvent(advisory: MaxDeliverAdvisory | TerminatedAdvisory): Omit<DeadLetterEvent, 'message'> {
  const type = advisory.type ?? ''
  const kind: DeadLetterKind = type.endsWith('.max_deliver')
    ? 'max_deliver'
    : type.endsWith('.terminated')
      ? 'terminated'
      : 'unknown'

  const terminated = advisory as TerminatedAdvisory
  return {
    kind,
    stream: advisory.stream,
    consumer: advisory.consumer,
    streamSeq: advisory.stream_seq,
    deliveries: advisory.deliveries,
    ...(kind === 'terminated'
      ? { consumerSeq: terminated.consumer_seq, reason: terminated.reason }
      : {}),
    advisory,
  }
}

export interface DeadLetterConsumerOptions {
  /**
   * The stream capturing advisory subjects. NOT the stream your messages are on.
   * Provision it with subjects [ADVISORY_MAX_DELIVERIES, ADVISORY_MSG_TERMINATED].
   */
  stream: string
  durable: string
  /** Create the durable if missing. Default 'never', as with defineNatsConsumer. */
  provision?: 'startup' | 'never'
  /** ms. Default 30_000. */
  ackWait?: number
  /**
   * Fetch the original message by sequence before invoking the handler. Default true.
   * Set false when you only need the metadata and want to skip a round trip per event.
   */
  recoverMessage?: boolean
  /** Handle both max-deliver and explicit-termination events. */
  onDeadLetter: (event: DeadLetterEvent, msg: JsMsg) => Promise<void>
}

/**
 * Consume dead-letter advisories durably.
 *
 * Deliberately has no `deadLetterSubject` of its own: routing a failed dead-letter handler
 * into another dead-letter subject builds a loop, and the last thing a failing system needs
 * is an amplifier. A handler that throws is naked and redelivered by the normal consumer
 * path instead.
 *
 * Like every consumer here, this runs only when NUXT_NATS_WORKERS=true.
 */
export function defineDeadLetterConsumer(opts: DeadLetterConsumerOptions) {
  const { recoverMessage = true } = opts

  return defineNatsConsumer<MaxDeliverAdvisory | TerminatedAdvisory>({
    stream: opts.stream,
    durable: opts.durable,
    filterSubjects: [ADVISORY_MAX_DELIVERIES, ADVISORY_MSG_TERMINATED],
    ackPolicy: 'explicit',
    ackWait: opts.ackWait ?? 30_000,
    provision: opts.provision ?? 'never',
    async handler(msg, payload) {
      const base = toDeadLetterEvent(payload)

      let message: StoredMsg | null = null
      if (recoverMessage) {
        try {
          const jsm = useJetStreamManager()
          message = await jsm.streams.getMessage(base.stream, { seq: base.streamSeq })
        }
        catch (err) {
          // A message that has aged out of its stream is expected, not exceptional: the
          // advisory outlives the message whenever max_age is shorter than the advisory
          // stream's. Report and carry on with metadata rather than failing the handler,
          // which would redeliver forever against a message that cannot come back.
          console.warn(
            `[nuxt-nats] Could not recover message ${base.stream}#${base.streamSeq} `
            + `for dead-letter handling:`,
            err,
          )
        }
      }

      await opts.onDeadLetter({ ...base, message }, msg)
    },
  })
}
