import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { connect, wsconnect } from '@nats-io/transport-node'
import type { NatsConnection, Status } from '@nats-io/nats-core'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { stopAllConsumers } from '../utils/consumer'
import { stopAllAgents } from '../utils/defineNatsAgent'
import { closeAgents } from '../utils/useAgents'
import { provisionStreams } from '../utils/provisionStreams'
import type { StreamDefinition } from '../utils/provisionStreams'
import { buildAuthOptions } from '../utils/buildConnectionOptions'
import { validateJwt } from '../utils/validateJwt'
import { _fireConnectError, _fireReconnect, _fireDisconnect } from '../utils/useNatsHooks'
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

  Object.assign(opts, buildAuthOptions(cfg))

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

async function drainAndClose() {
  const nc = getNatsConnection()
  if (_isClosing || !nc) return
  _isClosing = true
  try {
    // Stop agents first: tear down heartbeats + in-flight prompt streams and
    // the caller client before the connection drains (mirrors the consumer
    // ordering). Guard so a throw can't skip drain/cleanup below.
    try {
      await stopAllAgents()
      await closeAgents()
    }
    catch (err) {
      console.error('[nuxt-nats] Error stopping agents during shutdown:', err)
    }
    // Stop consumer loops next so no new acks are sent during drain
    stopAllConsumers()
    try {
      await nc.drain()
    }
    catch {
      // drain may throw if connection already closed
    }
  }
  finally {
    setNatsConnection(undefined)
    setJetStream(undefined)
    setJetStreamManager(undefined)
    _isClosing = false
  }
}

interface NatsRuntimeConfig {
  servers: string[]
  wsServers: string[]
  transport: string
  token: string
  user: string
  pass: string
  nkeySeed: string
  userJwt: string
  maxReconnectAttempts: number
  jsDomain: string
  jsApiPrefix: string
  tls?: { caFile?: string, certFile?: string, keyFile?: string }
  streams: StreamDefinition[]
  consumers: unknown[]
  health: { enabled?: boolean, endpoint?: string }
}

export default defineNitroPlugin(async (nitroApp) => {
  const config = useRuntimeConfig().nats as NatsRuntimeConfig

  validateJwt(config.userJwt)

  let nc: NatsConnection
  try {
    nc = await buildConnection(config)
    setNatsConnection(nc)
    console.log('[nuxt-nats] Connected to NATS')
  }
  catch (err) {
    console.error('[nuxt-nats] Failed to connect to NATS:', err)
    _fireConnectError(err instanceof Error ? err : new Error(String(err)))
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
  const server = (s as { server?: string }).server ?? ''
  if (s.type === 'disconnect') {
    console.warn('[nuxt-nats] Disconnected from NATS:', server)
    _fireDisconnect(server)
  }
  else if (s.type === 'reconnect') {
    console.log('[nuxt-nats] Reconnected to NATS:', server)
    _fireReconnect(server)
  }
  else if (s.type === 'error') {
    const err = (s as { error?: Error }).error
    const msg = String(err?.message ?? err ?? '')
    if (msg.includes('Authorization') || msg.includes('Permissions Violation')) {
      console.error('[nuxt-nats] AUTH ERROR — JWT may be expired or missing permissions:', err)
    }
    else {
      console.error('[nuxt-nats] NATS error:', err)
    }
  }
}
