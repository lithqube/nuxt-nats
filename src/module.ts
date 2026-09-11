import { join, isAbsolute } from 'node:path'
import {
  addServerImportsDir,
  addServerPlugin,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { defu } from 'defu'
import { generateConsumerPlugin } from './consumerTemplate'

// Public runtime types. The published types entry (dist/types.d.mts) re-exports only what
// this file exports, so without this line `declare module 'nuxt-nats' { interface NatsEvents
// {...} }` declared a new, unrelated interface and jsPublish never saw the user's subjects.
export type { NatsEvents, NatsConsumerOptions } from './runtime/types'

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

export interface ConsumerDefinition {
  stream: string
  durable: string
  filterSubjects?: string[]
  ackPolicy?: 'explicit' | 'none' | 'all'
  ackWait?: number
  maxDeliver?: number
  backoff?: number[]
  deadLetterSubject?: string
  /**
   * 'never'   — bind to an existing durable; never create one. Default.
   * 'startup' — create the durable from this definition if it does not exist.
   */
  provision?: 'startup' | 'never'
  /**
   * Path to the handler module, relative to `server/` or absolute. It must
   * default-export `(msg, payload) => Promise<void>`.
   */
  handler?: string
}

export interface ModuleOptions {
  /** NATS server URLs for the TCP transport. Also used by the WebSocket transport when wsServers is empty. Default: ['nats://localhost:4222'] */
  servers?: string[]
  /** NATS server URLs for the WebSocket transport (Bun under 'auto', edge runtimes with 'ws'). */
  wsServers?: string[]
  /** Transport selection. 'auto' uses WebSocket when running on Bun and TCP otherwise; set 'ws' for edge runtimes. Default: 'auto' */
  transport?: 'auto' | 'tcp' | 'ws'
  /** NATS auth token. Use NUXT_NATS_TOKEN env var in production. */
  token?: string
  /** NATS username for user/pass auth. */
  user?: string
  /** NATS password for user/pass auth. Use NUXT_NATS_PASS env var. */
  pass?: string
  /** NKey seed string (starts with "S"; not a file path). Use NUXT_NATS_NKEY_SEED env var. Signs the server nonce when userJwt is set; on its own it selects NKey auth. */
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
  /**
   * Consumers to register. Compiled into a generated Nitro plugin at build time, so the
   * handler modules are statically imported and survive bundling. Consumers start only
   * when NUXT_NATS_WORKERS=true.
   */
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

    // Declarative consumers are compiled into a generated Nitro plugin.
    //
    // Resolving ConsumerDefinition.handler at runtime is not possible in a bundled Nitro
    // server, which is why this option previously did nothing at all: the array reached
    // runtimeConfig and no code could act on it. Emitting static imports at build time is
    // what makes it real. Registered AFTER the connection plugin so useJetStream() is
    // available by the time a consumer starts.
    //
    // Deliberately not mirrored into runtimeConfig: the generated plugin is the single
    // source of truth, and a second copy could only ever drift from it.
    if (options.consumers?.length) {
      const serverDir = join(nuxt.options.srcDir, 'server')
      const generated = addTemplate({
        filename: 'nats-consumers.mjs',
        write: true,
        getContents: () => generateConsumerPlugin(options.consumers!, {
          consumerUtilPath: resolver.resolve('./runtime/server/utils/consumer'),
          resolveHandler: (h: string) => (isAbsolute(h) ? h : join(serverDir, h)),
        }),
      })
      addServerPlugin(generated.dst)
    }

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
