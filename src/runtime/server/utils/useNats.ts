import { getNatsConnection } from '../plugins/_connection'
import type { NatsConnection } from '@nats-io/nats-core'

export function useNats(): NatsConnection {
  const nc = getNatsConnection()
  if (!nc) {
    throw new Error('[nuxt-nats] NATS connection is not available. Ensure the nuxt-nats module is configured and the server has fully started.')
  }
  return nc
}
