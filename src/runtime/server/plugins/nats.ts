import { hostname } from 'node:os'
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { connect, wsconnect } from '@nats-io/transport-node'
import type { NatsConnection, Status } from '@nats-io/nats-core'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { stopAllConsumers } from '../utils/consumer'
import { stopAllAgents } from '../utils/defineNatsAgent'
import { closeAgents } from '../utils/useAgents'
import { provisionStreams } from '../utils/provisionStreams'
import type { StreamDefinition } from '../utils/provisionStreams'
import { buildAuthOptions, describeAuth } from '../utils/buildConnectionOptions'
import { normalizeServers } from '../utils/normalizeServers'
import { validateJwt } from '../utils/validateJwt'
import { _fireConnectError, _fireReconnect, _fireDisconnect, _fireCredentialsRefreshed, _fireCredentialsError } from '../utils/useNatsHooks'
import { createCredentialsProvider } from '../credentials'
import type { CredentialsRuntimeConfig } from '../credentials'
import { CredentialManager, getCredentialManager, setCredentialManager } from '../credentials/manager'
import { describeError } from '../credentials/redact'
import customCredentialsProvider from '#nuxt-nats/credentials-provider'
import {
  getNatsConnection,
  setNatsConnection,
  setAuthMode,
  setJetStream,
  setJetStreamManager,
} from './_connection'

export { getNatsConnection, getJetStream, getJetStreamManager, _setConnectionForTesting } from './_connection'

let _isClosing = false

function isBunRuntime(): boolean {
  return typeof globalThis !== 'undefined' && 'Bun' in globalThis
}

export function defaultConnectionName(): string {
  return `nuxt-nats@${hostname()}:${process.pid}`
}

async function buildConnection(cfg: NatsRuntimeConfig, manager?: CredentialManager): Promise<NatsConnection> {
  const opts: Record<string, unknown> = {
    maxReconnectAttempts: cfg.maxReconnectAttempts ?? -1,
    // Shown per connection in `nats server report connections` and Synadia Cloud's
    // connection graph, so each instance is recognizable.
    name: cfg.name || defaultConnectionName(),
  }

  if (manager) {
    opts.authenticator = manager.authenticator()
    // Two auth errors in a row would otherwise close the connection for good, before a
    // refresh has had a chance to deliver new credentials.
    opts.ignoreAuthErrorAbort = true
  }
  else {
    Object.assign(opts, buildAuthOptions(cfg))
  }

  if (cfg.tls && Object.keys(cfg.tls).length) {
    opts.tls = {
      ...(cfg.tls.caFile ? { caFile: cfg.tls.caFile } : {}),
      ...(cfg.tls.certFile ? { certFile: cfg.tls.certFile } : {}),
      ...(cfg.tls.keyFile ? { keyFile: cfg.tls.keyFile } : {}),
    }
  }

  const servers = normalizeServers(cfg.servers)
  const transport = cfg.transport ?? 'auto'
  const useWs = transport === 'ws' || (transport === 'auto' && isBunRuntime())

  if (useWs) {
    const wsServers = cfg.wsServers?.length ? normalizeServers(cfg.wsServers) : servers
    return wsconnect({ servers: wsServers, ...opts })
  }
  return connect({ servers, ...opts })
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
    await getCredentialManager()?.dispose()
  }
  finally {
    setNatsConnection(undefined)
    setAuthMode(undefined)
    setCredentialManager(undefined)
    setJetStream(undefined)
    setJetStreamManager(undefined)
    _isClosing = false
  }
}

interface NatsRuntimeConfig {
  name: string
  servers: string | string[]
  wsServers: string | string[]
  transport: string
  creds: string
  credsFile: string
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
  credentials?: CredentialsRuntimeConfig
  health: { enabled?: boolean, endpoint?: string, details?: boolean }
}

export default defineNitroPlugin(async (nitroApp) => {
  const config = useRuntimeConfig().nats as NatsRuntimeConfig

  let manager: CredentialManager | undefined
  let nc: NatsConnection
  try {
    const provider = createCredentialsProvider(config.credentials, customCredentialsProvider)
    if (provider) {
      manager = new CredentialManager(provider, config.credentials?.refresh, {
        onRefreshed: _fireCredentialsRefreshed,
        onError: _fireCredentialsError,
      })
      setCredentialManager(manager)
      setAuthMode(`provider:${provider.name}`)
      await manager.init()
    }
    else {
      const auth = describeAuth(config)
      setAuthMode(auth.mode)
      if (auth.jwt) validateJwt(auth.jwt, auth.source)
    }

    nc = await buildConnection(config, manager)
    setNatsConnection(nc)
    manager?.attach(() => nc.reconnect())
    console.log('[nuxt-nats] Connected to NATS')
  }
  catch (err) {
    console.error(`[nuxt-nats] Failed to connect to NATS: ${describeError(err)}`)
    await manager?.dispose()
    setCredentialManager(undefined)
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

  // Provision declared streams BEFORE publishing the JetStream singletons. Consumers
  // registered at plugin time wait for getJetStream() (Nitro does not await async plugins),
  // so publishing first would let a consumer with provision: 'startup' look up its durable
  // on a stream that does not exist yet and log a spurious loop error on first boot.
  if (config.streams?.length) {
    await provisionStreams(jsm, config.streams)
  }
  setJetStream(js)
  setJetStreamManager(jsm)

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

/**
 * True between a 'disconnect' status and the 'reconnect' that resolves it.
 *
 * The client emits a `reconnect` status per RETRY ATTEMPT, not per actual recovery
 * (nats.js#423, where one outage produced roughly 2400 of them). Firing onReconnect on
 * each would turn a single outage into a stampede for anyone using the hook to re-warm a
 * cache, flip a health flag or re-provision. Gating on the disconnect -> reconnect
 * transition collapses that to one event per real recovery.
 */
let _wasDisconnected = false

/** Exported for tests only, mirroring the _fire* convention in useNatsHooks. */
export function _resetStatusStateForTests() {
  _wasDisconnected = false
}

export function handleStatus(s: Status) {
  const server = (s as { server?: string }).server ?? ''
  if (s.type === 'disconnect') {
    console.warn('[nuxt-nats] Disconnected from NATS:', server)
    _wasDisconnected = true
    _fireDisconnect(server)
  }
  else if (s.type === 'reconnect') {
    if (!_wasDisconnected) return
    _wasDisconnected = false
    console.log('[nuxt-nats] Reconnected to NATS:', server)
    _fireReconnect(server)
  }
  else if (s.type === 'error') {
    const err = (s as { error?: Error }).error
    const msg = String(err?.message ?? err ?? '')
    if (msg.includes('Authorization') || msg.includes('Permissions Violation') || msg.includes('Authentication Expired')) {
      console.error('[nuxt-nats] AUTH ERROR — JWT may be expired or missing permissions:', err)
      // A provider may already have newer credentials: fetch them before the next reconnect.
      // A permissions violation is not a credentials problem, so it does not refresh.
      if (!msg.includes('Permissions Violation')) void getCredentialManager()?.refreshNow('auth-error')
    }
    else {
      console.error('[nuxt-nats] NATS error:', err)
    }
  }
}
