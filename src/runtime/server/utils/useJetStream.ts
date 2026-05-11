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
