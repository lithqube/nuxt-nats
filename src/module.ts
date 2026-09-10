import {
  addServerImportsDir,
  addServerPlugin,
  addServerHandler,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { defu } from 'defu'

export interface StreamDefinition {
  name: string
  subjects: string[]
  retention?: 'limits' | 'workqueue' | 'interest'
  storage?: 'file' | 'memory'
  replicas?: number
  maxAge?: string
  maxBytes?: number
  duplicateWindow?: string
  /**
   * 'startup'  — create the stream on boot; logs a warning if it already exists with a different config.
   * 'update'   — create the stream on boot; update it in-place if it already exists.
   * 'never'    — skip provisioning (use CLI/IaC instead). Default: 'never'
   */
  provision?: 'startup' | 'update' | 'never'
}

/**
 * @deprecated Not implemented. Declaring consumers in `nats.consumers` never started
 * one, and now fails the build rather than doing so silently. Use
 * `defineNatsConsumer()` inside a Nitro server plugin instead. Kept so existing configs
 * get a type-level signal alongside the build error rather than only the latter.
 */
export interface ConsumerDefinition {
  stream: string
  durable: string
  filterSubjects?: string[]
  ackPolicy?: 'explicit' | 'none' | 'all'
  ackWait?: number
  maxDeliver?: number
  backoff?: number[]
  deadLetterSubject?: string
  /** Never resolved by the runtime. */
  handler?: string
}

export interface ModuleOptions {
  /** NATS server URLs for TCP transport (Node / Bun). Default: ['nats://localhost:4222'] */
  servers?: string[]
  /** NATS server URLs for WebSocket transport (edge / Cloudflare Workers). */
  wsServers?: string[]
  /** Transport selection. 'auto' uses TCP on Node, WS on edge. Default: 'auto' */
  transport?: 'auto' | 'tcp' | 'ws'
  /** NATS auth token. Use NUXT_NATS_TOKEN env var in production. */
  token?: string
  /** NATS username for user/pass auth. */
  user?: string
  /** NATS password for user/pass auth. Use NUXT_NATS_PASSWORD env var. */
  pass?: string
  /** Path to NKey seed file. Requires @nats-io/nkeys. */
  nkeySeed?: string
  /** User JWT for auth against a JWT-resolver NATS server. Use alone for unsigned JWTs, or with nkeySeed for signed JWTs. */
  userJwt?: string
  /** TLS configuration. Set caFile for server TLS; add certFile + keyFile for mTLS. */
  tls?: {
    caFile?: string
    certFile?: string
    keyFile?: string
  }
  /** Max reconnect attempts. -1 = infinite. Default: -1 */
  maxReconnectAttempts?: number
  /** JetStream domain for multi-tenant setups. */
  jsDomain?: string
  /** JetStream API prefix override. */
  jsApiPrefix?: string
  /** Stream definitions to provision on startup. */
  streams?: StreamDefinition[]
  /** Declarative consumer definitions (runs only when NUXT_NATS_WORKERS=true). */
  /** @deprecated Not implemented; a non-empty array fails the build. See ConsumerDefinition. */
  consumers?: ConsumerDefinition[]
  health?: {
    /** Enable the /api/_nats/health endpoint. Default: true */
    enabled?: boolean
    /** Override the health endpoint path. Default: '/api/_nats/health' */
    endpoint?: string
  }
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-nats',
    configKey: 'nats',
    compatibility: { nuxt: '>=3.0.0' },
  },

  defaults: {
    servers: ['nats://localhost:4222'],
    transport: 'auto',
    maxReconnectAttempts: -1,
    streams: [],
    consumers: [],
    health: { enabled: true, endpoint: '/api/_nats/health' },
  },

  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    // `consumers` has never been wired to anything. The array was copied into
    // runtimeConfig and no runtime code read it back, and ConsumerDefinition.handler
    // (a module path) was resolved nowhere, so declaring consumers here produced a
    // build that started none of them and reported no error. Failing the build is the
    // smaller harm: a silently idle consumer looks identical to a healthy one until
    // messages pile up on the stream.
    if (options.consumers?.length) {
      throw new Error(
        `[nuxt-nats] \`nats.consumers\` is not implemented and never starts a consumer. `
        + `Declare consumers with defineNatsConsumer() inside a Nitro server plugin `
        + `(server/plugins/*.ts), which Nitro auto-registers, and set NUXT_NATS_WORKERS=true `
        + `so workers start. Note server/workers/*.ts is NOT scanned by Nitro.`,
      )
    }

    // Push NATS config into private runtimeConfig — credentials stay server-side only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nuxt.options.runtimeConfig.nats = defu(nuxt.options.runtimeConfig.nats as any, {
      servers: options.servers,
      wsServers: options.wsServers ?? [],
      transport: options.transport,
      token: options.token ?? '',
      user: options.user ?? '',
      pass: options.pass ?? '',
      nkeySeed: options.nkeySeed ?? '',
      userJwt: options.userJwt ?? '',
      tls: options.tls ?? null,
      maxReconnectAttempts: options.maxReconnectAttempts,
      jsDomain: options.jsDomain ?? '',
      jsApiPrefix: options.jsApiPrefix ?? '',
      streams: options.streams,
      health: options.health,
    })

    // Nitro plugin: manages connection lifecycle + SIGTERM drain
    addServerPlugin(resolver.resolve('./runtime/server/plugins/nats'))

    // Auto-import server utils: useNats(), useJetStream(), useKV(), publish()
    addServerImportsDir(resolver.resolve('./runtime/server/utils'))

    // Health endpoint
    const healthEnabled = options.health?.enabled !== false
    if (healthEnabled) {
      const endpoint = options.health?.endpoint ?? '/api/_nats/health'
      addServerHandler({
        route: endpoint,
        handler: resolver.resolve('./runtime/server/api/health.get'),
      })
    }

    // Keep NATS packages external — bundling breaks native TCP socket
    nuxt.hook('nitro:config', (nitroConfig) => {
      nitroConfig.externals ??= {}
      nitroConfig.externals.external ??= []
      const natsPackages = [
        '@nats-io/nats-core',
        '@nats-io/transport-node',
        '@nats-io/jetstream',
        '@nats-io/kv',
        '@nats-io/obj',
        '@nats-io/nkeys',
        '@nats-io/services',
        '@synadia-ai/agents',
        '@synadia-ai/agent-service',
      ]
      for (const pkg of natsPackages) {
        if (!nitroConfig.externals.external!.includes(pkg)) {
          nitroConfig.externals.external!.push(pkg)
        }
      }
    })
  },
})
