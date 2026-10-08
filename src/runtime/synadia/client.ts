import type {
  SynadiaAccount,
  SynadiaConnections,
  SynadiaIssuance,
  SynadiaKvBucket,
  SynadiaKvBucketConfig,
  SynadiaNatsUser,
  SynadiaNatsUserCreate,
  SynadiaRevocation,
  SynadiaStream,
  SynadiaStreamConfig,
  SynadiaSystemInfo,
  SynadiaTeam,
} from './types'

export interface SynadiaClientOptions {
  /**
   * A Control Plane token. Prefer a service-account token scoped to what the caller needs
   * (e.g. one NATS user) over a personal access token, which can do anything in the account.
   */
  token: string
  /** Default: https://cloud.synadia.com/api */
  apiUrl?: string
  /** Per-request timeout. Default: 15000 */
  timeoutMs?: number
  /** Retries for throttling, gateway errors and (for safe methods) network failures. Default: 2 */
  retries?: number
}

/** A failed Control Plane call. Carries the status and operation, never the response body. */
export class SynadiaApiError extends Error {
  readonly status?: number
  readonly operation: string
  readonly code: string

  constructor(operation: string, code: string, message: string, opts: { status?: number, cause?: unknown } = {}) {
    super(`[nuxt-nats] Synadia Control Plane ${operation}: ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'SynadiaApiError'
    this.operation = operation
    this.code = code
    this.status = opts.status
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
interface Call { body?: unknown, query?: Record<string, string | number | undefined>, text?: boolean, idempotent?: boolean }

const SAFE_RETRY = new Set([502, 503, 504])

function codeFor(status: number) {
  return status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : status === 429 ? 'rate-limited' : 'http-error'
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A typed client for the Synadia Control Plane API (`/core/beta`). Nitro-free; also used by the rotator CLI. */
export function createSynadiaClient(options: SynadiaClientOptions) {
  if (!options.token) throw new SynadiaApiError('config', 'config', 'a token is required')
  const base = `${(options.apiUrl || 'https://cloud.synadia.com/api').replace(/\/$/, '')}/core/beta`
  const timeoutMs = options.timeoutMs ?? 15_000
  const retries = options.retries ?? 2
  const enc = encodeURIComponent

  async function call<T>(operation: string, method: Method, path: string, c: Call = {}): Promise<T> {
    const query = c.query ? Object.entries(c.query).filter(([, v]) => v !== undefined && v !== '') : []
    const url = `${base}${path}${query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : ''}`
    // GET/PUT/DELETE are idempotent; a POST is retried only when the server says it did nothing (429).
    const idempotent = c.idempotent ?? (method === 'GET' || method === 'PUT' || method === 'DELETE')
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: c.text ? 'text/plain' : 'application/json',
            ...(c.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: c.body === undefined ? undefined : JSON.stringify(c.body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      }
      catch (err) {
        if (idempotent && attempt < retries) {
          await sleep(500 * 2 ** attempt)
          continue
        }
        const timedOut = (err as Error)?.name === 'TimeoutError'
        throw new SynadiaApiError(operation, timedOut ? 'timeout' : 'network', timedOut ? 'timed out' : 'request failed', { cause: err })
      }
      if (res.ok) {
        if (res.status === 204 || method === 'DELETE') return undefined as T
        return (c.text ? await res.text() : await res.json()) as T
      }
      const retryable = res.status === 429 || (idempotent && SAFE_RETRY.has(res.status))
      if (retryable && attempt < retries) {
        const after = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 500 * 2 ** attempt)
        continue
      }
      throw new SynadiaApiError(operation, codeFor(res.status), `HTTP ${res.status}`, { status: res.status })
    }
  }

  const items = <T>(r: { items?: T[] }) => r.items ?? []

  return {
    listTeams: async () => items(await call<{ items: SynadiaTeam[] }>('listTeams', 'GET', '/teams')),
    listSystems: async (teamId: string) => items(await call<{ items: SynadiaSystemInfo[] }>('listTeamSystems', 'GET', `/teams/${enc(teamId)}/systems`)),
    listAccounts: async (systemId: string) => items(await call<{ items: SynadiaAccount[] }>('listAccounts', 'GET', `/systems/${enc(systemId)}/accounts`)),
    getAccount: (accountId: string) => call<SynadiaAccount>('getAccount', 'GET', `/accounts/${enc(accountId)}`),
    listConnections: (accountId: string, query: { limit?: number, state?: string, user?: string } = {}) =>
      call<{ items: SynadiaConnections[] }>('listAccountConnections', 'GET', `/accounts/${enc(accountId)}/connections`, { query }).then(items),

    natsUsers: {
      list: async (accountId: string) => items(await call<{ items: SynadiaNatsUser[] }>('listUsers', 'GET', `/accounts/${enc(accountId)}/nats-users`)),
      get: (userId: string) => call<SynadiaNatsUser>('getUser', 'GET', `/nats-users/${enc(userId)}`),
      create: (accountId: string, user: SynadiaNatsUserCreate) => call<SynadiaNatsUser>('createUser', 'POST', `/accounts/${enc(accountId)}/nats-users`, {
        body: user.jwt_settings
          ? { ...user, jwt_settings: { data: -1, payload: -1, subs: -1, ...user.jwt_settings } }
          : user,
      }),
      /** Issue a `.creds` file. Every call is an issuance with a fresh JWT. */
      issueCreds: (userId: string) => call<string>('downloadNatsUserCreds', 'POST', `/nats-users/${enc(userId)}/creds`, { text: true, idempotent: true }),
      /** Issue a bearer JWT (the user must allow bearer tokens). */
      issueBearerJwt: (userId: string) => call<string>('downloadNatsUserBearerJwt', 'POST', `/nats-users/${enc(userId)}/bearer-jwt`, { text: true, idempotent: true }),
      /** Generate a new nkey for the user. Creds issued for the old key stay valid until they expire or are revoked. */
      rotate: (userId: string) => call<SynadiaNatsUser>('rotateNatsUser', 'POST', `/nats-users/${enc(userId)}/rotate`),
      listIssuances: async (userId: string) => items(await call<{ items: SynadiaIssuance[] }>('listNatsUserIssuances', 'GET', `/nats-users/${enc(userId)}/issuances`)),
      /** Reject JWTs for `userNkeyPublic` issued before `before` (epoch seconds; default now). */
      revoke: (accountId: string, userNkeyPublic: string, before = Math.floor(Date.now() / 1000)) =>
        call<SynadiaRevocation>('createOrUpdateNatsUserRevocation', 'PUT', `/accounts/${enc(accountId)}/nats-user-revocations/${enc(userNkeyPublic)}`, { body: { before } }),
      unrevoke: (accountId: string, userNkeyPublic: string) =>
        call<undefined>('deleteNatsUserRevocation', 'DELETE', `/accounts/${enc(accountId)}/nats-user-revocations/${enc(userNkeyPublic)}`),
    },

    streams: {
      list: async (accountId: string) => items(await call<{ items: SynadiaStream[] }>('listStreams', 'GET', `/accounts/${enc(accountId)}/jetstream/streams`)),
      get: (streamId: string) => call<SynadiaStream>('getStream', 'GET', `/jetstream/stream/${enc(streamId)}`),
      create: (accountId: string, config: SynadiaStreamConfig) => call<SynadiaStream>('createStream', 'POST', `/accounts/${enc(accountId)}/jetstream/streams`, { body: config }),
      update: (streamId: string, config: Partial<SynadiaStreamConfig>) => call<SynadiaStream>('updateStream', 'PATCH', `/jetstream/stream/${enc(streamId)}`, { body: config }),
      delete: (streamId: string) => call<undefined>('deleteStream', 'DELETE', `/jetstream/stream/${enc(streamId)}`),
    },

    kvBuckets: {
      list: async (accountId: string) => items(await call<{ items: SynadiaKvBucket[] }>('listKvBuckets', 'GET', `/accounts/${enc(accountId)}/jetstream/kv-buckets`)),
      create: (accountId: string, config: SynadiaKvBucketConfig) => call<SynadiaKvBucket>('createKvBucket', 'POST', `/accounts/${enc(accountId)}/jetstream/kv-buckets`, {
        body: { history: 1, storage: 'file', num_replicas: 1, compression: false, ...config },
      }),
      delete: (streamId: string) => call<undefined>('deleteKvBucket', 'DELETE', `/jetstream/kv-bucket/${enc(streamId)}`),
    },
  }
}

export type SynadiaClient = ReturnType<typeof createSynadiaClient>
