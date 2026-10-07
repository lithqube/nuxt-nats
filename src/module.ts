import { join, isAbsolute } from 'node:path'
import {
  addServerImportsDir,
  addNitroPlugin,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { defu } from 'defu'
import { generateConsumerPlugin } from './consumerTemplate'
import { synadiaServers } from './synadia'
import { CREDENTIALS_PROVIDER_ID, generateProviderModule } from './providerTemplate'
import type { SynadiaCloudOptions } from './synadia'

export type { SynadiaCloudOptions, SynadiaRegion } from './synadia'

// Public runtime types. The published types entry (dist/types.d.mts) re-exports only what
// this file exports, so without this line `declare module 'nuxt-nats' { interface NatsEvents
// {...} }` declared a new, unrelated interface and jsPublish never saw the user's subjects.
export type { NatsEvents, NatsConsumerOptions, NatsCredentials, NatsCredentialsProvider, CredentialsFetchContext } from './runtime/types'

export interface StreamDefinition {
  name: string
  subjects: string[]
  retention?: 'limits' | 'workqueue' | 'interest'
  storage?: 'file' | 'memory'
  replicas?: number
  maxAge?: string
  maxBytes?: number
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
  /**
   * Connect to Synadia Cloud. Sets `servers` and `wsServers` to the region's TLS and
   * WebSocket endpoints unless they are set explicitly. Authenticate with `credsFile` or
   * NUXT_NATS_CREDS. `true` is the geo-routed global endpoint.
   */
  synadia?: boolean | SynadiaCloudOptions
  /** NATS server URLs for the TCP transport. Also used by the WebSocket transport when wsServers is empty. Default: ['nats://localhost:4222'] */
  servers?: string[]
  /** NATS server URLs for the WebSocket transport (Bun under 'auto', edge runtimes with 'ws'). */
  wsServers?: string[]
  /** Transport selection. 'auto' uses WebSocket when running on Bun and TCP otherwise; set 'ws' for edge runtimes. Default: 'auto' */
  transport?: 'auto' | 'tcp' | 'ws'
  /** Connection name shown in server reports and Synadia Cloud. Default: `nuxt-nats@<hostname>:<pid>` */
  name?: string
  /**
   * Creds file contents (user JWT + NKey seed), raw or base64. Set it with the NUXT_NATS_CREDS
   * env var, never in nuxt.config: a value set at build time is written into the build output.
   * Takes priority over every other auth method.
   */
  creds?: string
  /**
   * Path to a `.creds` file, read at runtime and re-read on every reconnect, so a rotated
   * file (e.g. a Kubernetes Secret volume) is picked up without a restart. Env: NUXT_NATS_CREDS_FILE
   */
  credsFile?: string
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
  /**
   * Credentials that change over time, fetched before connecting and refreshed ahead of
   * expiry with no restart. Secrets in here come from env vars (NUXT_NATS_CREDENTIALS_*).
   * Without this, the static settings above (creds, credsFile, userJwt, ...) are used.
   */
  credentials?: CredentialsOptions
  health?: {
    /** Enable the /api/_nats/health endpoint. Default: true */
    enabled?: boolean
    /** Override the health endpoint path. Default: '/api/_nats/health' */
    endpoint?: string
    /**
     * Add credentials status (provider, status, seconds to expiry, last error code) to the
     * response. Never identities or secrets, but the endpoint is public. Default: false
     */
    details?: boolean
  }
}

export interface CredentialsOptions {
  /**
   * 'static' (default) — the creds / JWT / token settings, read at connect.
   * 'infisical' — read from an Infisical secret with a machine identity.
   * 'synadia'  — issue fresh creds from the Synadia Control Plane.
   * 'custom'   — your provider from `customProvider`.
   */
  provider?: 'static' | 'infisical' | 'synadia' | 'custom'
  /**
   * Path to a file that default-exports `defineNatsCredentialsProvider({ name, fetch })`,
   * relative to the server directory or absolute. Bundled whenever set; used when provider
   * is 'custom', which can also be chosen at runtime with NUXT_NATS_CREDENTIALS_PROVIDER.
   */
  customProvider?: string
  refresh?: {
    /** Refresh this fraction of the JWT lifetime before expiry. Default: 0.2 */
    leadRatio?: number
    /** Bounds of that lead, in seconds. Defaults: 60 and 3600 */
    minLeadSec?: number
    maxLeadSec?: number
    /** Refresh interval for credentials without an expiry. Default: 300 */
    pollSec?: number
    /** Retry backoff cap after a failure, in seconds. Default: 60 */
    maxBackoffSec?: number
    /** How long boot waits for the first credentials, in seconds. Default: 30 */
    initTimeoutSec?: number
  }
  infisical?: {
    /** Default: https://app.infisical.com */
    siteUrl?: string
    projectId?: string
    environment?: string
    /** Default: '/' */
    secretPath?: string
    /** Secret holding the `.creds` file (raw or base64) or a bearer user JWT. */
    secretName?: string
    auth?: {
      /** 'universal' (client id + secret), 'kubernetes' (pod service account) or 'oidc'. */
      method?: 'universal' | 'kubernetes' | 'oidc'
      identityId?: string
      clientId?: string
      /** Env: NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_CLIENT_SECRET */
      clientSecret?: string
      /** Identity token file (kubernetes default: the pod's service-account token). */
      tokenPath?: string
      /** Identity token value. Env: NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_JWT */
      jwt?: string
    }
  }
  synadia?: {
    /** Default: https://cloud.synadia.com/api */
    apiUrl?: string
    userId?: string
    /** A service-account token scoped to this NATS user. Env: NUXT_NATS_CREDENTIALS_SYNADIA_TOKEN */
    token?: string
  }
}

/** Credential options and the env vars that should carry them instead of nuxt.config. */
const SECRET_OPTIONS = [
  ['creds', 'NUXT_NATS_CREDS'],
  ['token', 'NUXT_NATS_TOKEN'],
  ['pass', 'NUXT_NATS_PASS'],
  ['nkeySeed', 'NUXT_NATS_NKEY_SEED'],
  ['userJwt', 'NUXT_NATS_USER_JWT'],
] as const satisfies ReadonlyArray<readonly [keyof ModuleOptions, string]>

/** Credentials-provider secrets, as [option path, env var]. */
function literalProviderSecrets(c: CredentialsOptions | undefined): Array<[string, string]> {
  const found: Array<[string, string]> = []
  if (c?.infisical?.auth?.clientSecret) found.push(['credentials.infisical.auth.clientSecret', 'NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_CLIENT_SECRET'])
  if (c?.infisical?.auth?.jwt) found.push(['credentials.infisical.auth.jwt', 'NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_JWT'])
  if (c?.synadia?.token) found.push(['credentials.synadia.token', 'NUXT_NATS_CREDENTIALS_SYNADIA_TOKEN'])
  return found
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-nats',
    configKey: 'nats',
    compatibility: { nuxt: '>=4.0.0' },
  },

  defaults: {
    transport: 'auto',
    maxReconnectAttempts: -1,
    streams: [],
    consumers: [],
    health: { enabled: true, endpoint: '/api/_nats/health', details: false },
  },

  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    // Synadia Cloud fills in its endpoints; explicit servers still win.
    const cloud = options.synadia
      ? synadiaServers(options.synadia === true ? 'global' : options.synadia.region)
      : undefined
    const servers = options.servers ?? cloud?.servers ?? ['nats://localhost:4222']
    const wsServers = options.wsServers ?? cloud?.wsServers ?? []

    // Synadia Cloud rejects a stream without max_bytes ("account requires a stream config to
    // have max bytes set"), so catch it at build time rather than at the first boot.
    if (options.synadia) {
      const unbounded = (options.streams ?? [])
        .filter(s => (s.provision === 'startup' || s.provision === 'update') && !(s.maxBytes && s.maxBytes > 0))
        .map(s => s.name)
      if (unbounded.length) {
        console.warn(`[nuxt-nats] Synadia Cloud requires maxBytes on every stream; set it on: ${unbounded.join(', ')}`)
      }
    }

    // Values set in nuxt.config are serialized into the build output (.output), so a
    // credential there ships with every artifact. Runtime env vars do not.
    if (!nuxt.options.dev) {
      const literal: Array<readonly [string, string]> = [
        ...SECRET_OPTIONS.filter(([key]) => options[key]),
        ...literalProviderSecrets(options.credentials),
      ]
      if (literal.length) {
        console.warn(
          `[nuxt-nats] ${literal.map(([key]) => `nats.${key}`).join(', ')} set in nuxt.config is written into the build output. `
          + `Set ${literal.map(([, env]) => env).join(', ')} at runtime instead.`,
        )
      }
    }

    // Push NATS config into private runtimeConfig — credentials stay server-side only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nuxt.options.runtimeConfig.nats = defu(nuxt.options.runtimeConfig.nats as any, {
      name: options.name ?? '',
      servers,
      wsServers,
      transport: options.transport,
      // Pre-seeded with '' so NUXT_NATS_CREDS / NUXT_NATS_CREDS_FILE map at runtime.
      creds: options.creds ?? '',
      credsFile: options.credsFile ?? '',
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
      // Every leaf pre-seeded so NUXT_NATS_CREDENTIALS_* env vars map at runtime.
      credentials: {
        provider: options.credentials?.provider ?? '',
        refresh: {
          leadRatio: options.credentials?.refresh?.leadRatio ?? 0,
          minLeadSec: options.credentials?.refresh?.minLeadSec ?? 0,
          maxLeadSec: options.credentials?.refresh?.maxLeadSec ?? 0,
          pollSec: options.credentials?.refresh?.pollSec ?? 0,
          maxBackoffSec: options.credentials?.refresh?.maxBackoffSec ?? 0,
          initTimeoutSec: options.credentials?.refresh?.initTimeoutSec ?? 0,
        },
        infisical: {
          siteUrl: options.credentials?.infisical?.siteUrl ?? '',
          projectId: options.credentials?.infisical?.projectId ?? '',
          environment: options.credentials?.infisical?.environment ?? '',
          secretPath: options.credentials?.infisical?.secretPath ?? '',
          secretName: options.credentials?.infisical?.secretName ?? '',
          auth: {
            method: options.credentials?.infisical?.auth?.method ?? '',
            identityId: options.credentials?.infisical?.auth?.identityId ?? '',
            clientId: options.credentials?.infisical?.auth?.clientId ?? '',
            clientSecret: options.credentials?.infisical?.auth?.clientSecret ?? '',
            tokenPath: options.credentials?.infisical?.auth?.tokenPath ?? '',
            jwt: options.credentials?.infisical?.auth?.jwt ?? '',
          },
        },
        synadia: {
          apiUrl: options.credentials?.synadia?.apiUrl ?? '',
          userId: options.credentials?.synadia?.userId ?? '',
          token: options.credentials?.synadia?.token ?? '',
        },
      },
    })

    // Nitro plugin: manages connection lifecycle + SIGTERM drain
    addNitroPlugin(resolver.resolve('./runtime/server/plugins/nats'))

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
      // Handler paths are relative to the server directory. Not `<srcDir>/server`: in Nuxt 4
      // srcDir is app/ whenever that directory exists, while server/ stays at the root. A path
      // that does not resolve only warns at build time, then crashes every process at startup
      // with ERR_MODULE_NOT_FOUND.
      const serverDir = nuxt.options.serverDir
      const generated = addTemplate({
        filename: 'nats-consumers.mjs',
        write: true,
        getContents: () => generateConsumerPlugin(options.consumers!, {
          consumerUtilPath: resolver.resolve('./runtime/server/utils/consumer'),
          resolveHandler: (h: string) => (isAbsolute(h) ? h : join(serverDir, h)),
        }),
      })
      addNitroPlugin(generated.dst)
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
    // The custom credentials provider, as a virtual module the connection plugin imports
    // statically (src/providerTemplate.ts explains why not a generated plugin).
    // Bundled whenever it is set, so the provider can be chosen at runtime
    // (NUXT_NATS_CREDENTIALS_PROVIDER=custom) without a rebuild.
    const custom = options.credentials?.customProvider
    const providerPath = custom ? (isAbsolute(custom) ? custom : join(nuxt.options.serverDir, custom)) : undefined

    nuxt.hook('nitro:config', (nitroConfig) => {
      nitroConfig.virtual ??= {}
      nitroConfig.virtual[CREDENTIALS_PROVIDER_ID] = generateProviderModule(providerPath)

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
