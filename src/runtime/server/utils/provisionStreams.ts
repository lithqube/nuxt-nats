import { JetStreamApiError } from '@nats-io/jetstream'
import type { JetStreamManager, StreamConfig } from '@nats-io/jetstream'
import { parseDuration } from './parseDuration'

/** NATS JetStream error code: stream name already in use with a different configuration. */
const ERR_STREAM_NAME_IN_USE = 10058

export interface StreamDefinition {
  name: string
  subjects: string[]
  retention?: string
  storage?: string
  replicas?: number
  maxBytes?: number
  maxAge?: string
  duplicateWindow?: string
  /**
   * 'startup'  — create the stream on boot; logs a warning if it already exists with a different config.
   * 'update'   — create the stream on boot; update it in-place if it already exists.
   * 'never'    — skip provisioning (use CLI/IaC instead). Default: 'never'
   */
  provision?: 'startup' | 'update' | 'never'
}

export async function provisionStreams(jsm: JetStreamManager, streams: StreamDefinition[]) {
  for (const def of streams) {
    if (def.provision !== 'startup' && def.provision !== 'update') continue

    const cfg: Partial<StreamConfig> = {
      name: def.name,
      subjects: def.subjects,
      retention: def.retention === 'workqueue' ? 'workqueue' : def.retention === 'interest' ? 'interest' : 'limits',
      storage: def.storage === 'memory' ? 'memory' : 'file',
      num_replicas: def.replicas ?? 1,
      max_bytes: def.maxBytes ?? -1,
    }
    if (def.maxAge) cfg.max_age = parseDuration(def.maxAge)
    if (def.duplicateWindow) cfg.duplicate_window = parseDuration(def.duplicateWindow)

    try {
      await jsm.streams.add(cfg as StreamConfig)
      console.log(`[nuxt-nats] Stream "${def.name}" provisioned`)
    }
    catch (err: unknown) {
      if (err instanceof JetStreamApiError && err.code === ERR_STREAM_NAME_IN_USE) {
        if (def.provision === 'update') {
          try {
            await jsm.streams.update(def.name, cfg as StreamConfig)
            console.log(`[nuxt-nats] Stream "${def.name}" updated`)
          }
          catch (updateErr: unknown) {
            console.error(`[nuxt-nats] Failed to update stream "${def.name}":`, updateErr)
          }
        }
        else {
          console.warn(`[nuxt-nats] Stream "${def.name}" already exists with a different config. Skipping — reconcile manually or via CLI.`)
        }
      }
      else {
        console.error(`[nuxt-nats] Failed to provision stream "${def.name}":`, err)
      }
    }
  }
}
