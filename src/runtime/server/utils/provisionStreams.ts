import { JetStreamApiError } from '@nats-io/jetstream'
import type { JetStreamManager, StreamConfig } from '@nats-io/jetstream'
import { parseDuration } from './parseDuration'

/** NATS JetStream error code: stream name already in use with a different configuration. */
const ERR_STREAM_NAME_IN_USE = 10058

/**
 * Errors that mean the account or its placement cannot hold the stream. On Synadia Cloud
 * these are plan limits (the free plan is R1-only, 10 streams), so the raw server text is
 * followed by what to check.
 */
const LIMIT_HINTS: Record<number, string> = {
  10023: 'insufficient resources — no server matches the placement and replicas; check placement tags and whether your plan allows this replica count (Synadia Cloud free plan: R1 only)',
  10027: 'maximum number of streams reached — your account or plan stream limit is used up',
  10028: 'insufficient memory resources — the account memory storage limit is used up',
  10047: 'insufficient storage resources — the account file storage limit is used up',
  10113: 'the account requires max_bytes on every stream — set maxBytes on this stream definition',
}

/** A readable explanation for a stream create/update failure, or undefined for other errors. */
export function explainStreamError(err: unknown): string | undefined {
  if (err instanceof JetStreamApiError) return LIMIT_HINTS[err.code]
  return undefined
}

function logProvisionError(action: string, name: string, err: unknown) {
  const hint = explainStreamError(err)
  if (hint) console.error(`[nuxt-nats] Failed to ${action} stream "${name}": ${hint}.`, err)
  else console.error(`[nuxt-nats] Failed to ${action} stream "${name}":`, err)
}

export interface StreamDefinition {
  name: string
  subjects: string[]
  retention?: string
  storage?: string
  replicas?: number
  maxBytes?: number
  maxAge?: string
  duplicateWindow?: string
  /** Where the stream is placed. On Synadia Cloud use tags such as `geo:europe` or `geo:us`. */
  placement?: { cluster?: string, tags?: string[] }
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
    if (def.placement && (def.placement.cluster || def.placement.tags?.length)) {
      cfg.placement = {
        ...(def.placement.cluster ? { cluster: def.placement.cluster } : {}),
        ...(def.placement.tags?.length ? { tags: def.placement.tags } : {}),
      } as StreamConfig['placement']
    }

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
            logProvisionError('update', def.name, updateErr)
          }
        }
        else {
          console.warn(`[nuxt-nats] Stream "${def.name}" already exists with a different config. Skipping — reconcile manually or via CLI.`)
        }
      }
      else {
        logProvisionError('provision', def.name, err)
      }
    }
  }
}
