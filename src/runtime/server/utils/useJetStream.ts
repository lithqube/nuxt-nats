import { getJetStream, getJetStreamManager } from '../plugins/_connection'
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'

export function useJetStream(): JetStreamClient {
  const js = getJetStream()
  if (!js) {
    throw new Error('[nuxt-nats] JetStream client is not available. Ensure jetstream is enabled and the NATS connection is established.')
  }
  return js
}

export function useJetStreamManager(): JetStreamManager {
  const jsm = getJetStreamManager()
  if (!jsm) {
    throw new Error('[nuxt-nats] JetStream manager is not available. Ensure jetstream is enabled and the NATS connection is established.')
  }
  return jsm
}

/**
 * Returns the JetStream client, or null if the NATS connection is not yet established.
 * Use this in handlers where you want to return a clean error instead of throwing a 500.
 *
 * @example
 *   const js = useJetStreamIfAvailable()
 *   if (!js) throw createError({ statusCode: 503, message: 'NATS not available' })
 */
export function useJetStreamIfAvailable(): JetStreamClient | null {
  return getJetStream() ?? null
}
