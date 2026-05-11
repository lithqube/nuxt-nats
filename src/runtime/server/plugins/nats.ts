import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { connect } from '@nats-io/transport-node'
import { wsconnect, type NatsConnection, type Status } from '@nats-io/nats-core'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import type { JetStreamManager, StreamConfig } from '@nats-io/jetstream'
import { parseDuration } from '../utils/parseDuration'
import {
  getNatsConnection,
  setNatsConnection,
  setJetStream,
  setJetStreamManager,
} from './_connection'

export { getNatsConnection, getJetStream, getJetStreamManager, _setConnectionForTesting } from './_connection'

let _isClosing = false

function isBunRuntime(): boolean {
  return typeof globalThis !== 'undefined' && 'Bun' in globalThis
}

async function buildConnection(cfg: NatsRuntimeConfig): Promise<NatsConnection> {
  const opts: Record<string, unknown> = {
    maxReconnectAttempts: cfg.maxReconnectAttempts ?? -1,
  }

  if (cfg.token) opts.token = cfg.token
  if (cfg.user) opts.user = cfg.user
  if (cfg.pass) opts.pass = cfg.pass

  if (cfg.tls && Object.keys(cfg.tls).length) {
    opts.tls = {
      ...(cfg.tls.caFile ? { caFile: cfg.tls.caFile } : {}),
      ...(cfg.tls.certFile ? { certFile: cfg.tls.certFile } : {}),
      ...(cfg.tls.keyFile ? { keyFile: cfg.tls.keyFile } : {}),
    }
  }

  const transport = cfg.transport ?? 'auto'
  const useWs = transport === 'ws' || (transport === 'auto' && isBunRuntime())

  if (useWs) {
    const wsServers = cfg.wsServers?.length ? cfg.wsServers : cfg.servers
    return wsconnect({ servers: wsServers, ...opts })
  }
  return connect({ servers: cfg.servers, ...opts })
}

async function provisionStreams(jsm: JetStreamManager, streams: StreamDefinitionRuntime[]) {
  for (const def of streams) {
    if (def.provision !== 'startup') continue

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
      const apiErr = (err as { api_error?: { err_code?: number } }).api_error
      if (apiErr?.err_code === 10058) {
        console.warn(`[nuxt-nats] Stream "${def.name}" already exists with a different config. Skipping — reconcile manually or via CLI.`)
      }
      else {
        console.error(`[nuxt-nats] Failed to provision stream "${def.name}":`, err)
      }
    }
  }
}

async function drainAndClose() {
  const nc = getNatsConnection()
  if (_isClosing || !nc) return
  _isClosing = true
  try {
    await nc.drain()
  }
  catch {
    // drain may throw if connection already closed
  }
  setNatsConnection(undefined)
  setJetStream(undefined)
  setJetStreamManager(undefined)
  _isClosing = false
}

interface StreamDefinitionRuntime {
  name: string
  subjects: string[]
  retention?: string
  storage?: string
  replicas?: number
  maxBytes?: number
  maxAge?: string
  duplicateWindow?: string
  provision?: string
}

interface NatsRuntimeConfig {
  servers: string[]
  wsServers: string[]
  transport: string
  token: string
  user: string
  pass: string
  nkeySeed: string
  maxReconnectAttempts: number
  jsDomain: string
  jsApiPrefix: string
  tls?: { caFile?: string; certFile?: string; keyFile?: string }
  streams: StreamDefinitionRuntime[]
  consumers: unknown[]
  health: { enabled?: boolean; endpoint?: string }
}

export default defineNitroPlugin(async (nitroApp) => {
  const config = useRuntimeConfig().nats as NatsRuntimeConfig

  let nc: NatsConnection
  try {
    nc = await buildConnection(config)
    setNatsConnection(nc)
    console.log('[nuxt-nats] Connected to NATS')
  }
  catch (err) {
    console.error('[nuxt-nats] Failed to connect to NATS:', err)
    return
  }

  // Watch for status changes (disconnect / reconnect / error)
  ;(async () => {
    for await (const s of nc.status()) {
      handleStatus(s)
    }
  })()

  // Set up JetStream
  const jsOpts: Record<string, unknown> = {}
  if (config.jsDomain) jsOpts.domain = config.jsDomain
  if (config.jsApiPrefix) jsOpts.apiPrefix = config.jsApiPrefix

  const jsOptsArg = Object.keys(jsOpts).length ? jsOpts : undefined
  const js = jetstream(nc, jsOptsArg)
  const jsm = await jetstreamManager(nc, jsOptsArg)
  setJetStream(js)
  setJetStreamManager(jsm)

  // Provision streams declared with provision: 'startup'
  if (config.streams?.length) {
    await provisionStreams(jsm, config.streams)
  }

  // Graceful shutdown via Nitro hook
  nitroApp.hooks.hook('close', async () => {
    console.log('[nuxt-nats] Nitro closing — draining NATS connection')
    await drainAndClose()
  })

  // Manual signal handlers — Nitro close hook unreliable on SIGTERM (nitrojs/nitro#4015)
  const shutdown = async (signal: string) => {
    console.log(`[nuxt-nats] ${signal} received — draining NATS connection`)
    await drainAndClose()
    process.exit(0)
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
})

function handleStatus(s: Status) {
  if (s.type === 'disconnect') {
    console.warn('[nuxt-nats] Disconnected from NATS:', (s as { server?: string }).server)
  }
  else if (s.type === 'reconnect') {
    console.log('[nuxt-nats] Reconnected to NATS:', (s as { server?: string }).server)
  }
  else if (s.type === 'error') {
    console.error('[nuxt-nats] NATS error:', (s as { error?: Error }).error)
  }
}
