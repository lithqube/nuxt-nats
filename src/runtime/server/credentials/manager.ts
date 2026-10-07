import { createHash } from 'node:crypto'
import { jwtAuthenticator } from '@nats-io/nats-core'
import type { Authenticator } from '@nats-io/nats-core'
import { decodeCredsInput, parseCreds } from '../utils/parseCreds'
import { jwtTimes } from './jwt'
import { describeError } from './redact'
import { CredentialsProviderError } from './types'
import type { CredentialsFetchContext, NatsCredentials, NatsCredentialsProvider } from './types'

export interface RefreshOptions {
  /** Refresh this fraction of the JWT lifetime before it expires. Default: 0.2 */
  leadRatio?: number
  /** Lower bound of that lead, in seconds. Default: 60 */
  minLeadSec?: number
  /** Upper bound of that lead, in seconds. Default: 3600 */
  maxLeadSec?: number
  /** Refresh interval for credentials without an expiry (picks up external rotation). Default: 300 */
  pollSec?: number
  /** Cap on the retry backoff after a failed refresh, in seconds. Default: 60 */
  maxBackoffSec?: number
  /** How long boot waits for the first credentials before giving up, in seconds. Default: 30 */
  initTimeoutSec?: number
}

export type CredentialsStatus = 'pending' | 'ok' | 'stale' | 'expired' | 'failed'

export interface CredentialsSnapshot {
  provider: string
  status: CredentialsStatus
  /** Seconds until the current JWT expires; null when it does not expire. */
  expiresInSec: number | null
  nextRefreshInSec: number | null
  lastRefreshAt: string | null
  lastErrorCode: string | null
}

export interface CredentialManagerEvents {
  onRefreshed?: (info: { expiresAt?: number, changed: boolean }) => void
  onError?: (err: Error) => void
}

interface Current {
  jwt: string
  seed?: Uint8Array
  iat?: number
  exp?: number
  fingerprint: string
}

const DEFAULTS: Required<RefreshOptions> = {
  leadRatio: 0.2,
  minLeadSec: 60,
  maxLeadSec: 3600,
  pollSec: 300,
  maxBackoffSec: 60,
  initTimeoutSec: 30,
}

// Do not reconnect more often than this when credentials change repeatedly.
const MIN_RECONNECT_INTERVAL_MS = 30_000
// Ignore auth-error refresh triggers closer together than this (a reconnect storm).
const MIN_AUTH_ERROR_REFRESH_MS = 5_000
const FETCH_TIMEOUT_MS = 15_000

/** Normalize what a provider returned into a JWT and optional seed. */
export function normalizeCredentials(provider: string, c: NatsCredentials): Current {
  let jwt: string
  let seed: string | undefined
  if (c.creds) {
    let parsed
    try {
      parsed = parseCreds(decodeCredsInput(c.creds))
    }
    catch (err) {
      throw new CredentialsProviderError(provider, 'bad-credentials', 'returned a value that is not a creds file', { cause: err })
    }
    jwt = parsed.jwt
    seed = parsed.seed
  }
  else if (c.userJwt) {
    jwt = c.userJwt
    seed = c.nkeySeed || undefined
  }
  else {
    throw new CredentialsProviderError(provider, 'bad-credentials', 'returned neither creds nor userJwt')
  }
  const { iat, exp } = jwtTimes(jwt)
  return {
    jwt,
    seed: seed ? new TextEncoder().encode(seed) : undefined,
    iat,
    exp: c.expiresAt ?? exp,
    fingerprint: createHash('sha256').update(jwt).update('\0').update(seed ?? '').digest('hex'),
  }
}

/** When to refresh, in ms from `nowMs`. Jittered by ±10% of the lead so a fleet spreads out. */
export function refreshDelayMs(cur: { iat?: number, exp?: number }, nowMs: number, o: Required<RefreshOptions>, random = Math.random): number {
  if (!cur.exp) return o.pollSec * 1000
  const lifetime = cur.iat ? cur.exp - cur.iat : o.maxLeadSec * 5
  const lead = Math.min(o.maxLeadSec, Math.max(o.minLeadSec, lifetime * o.leadRatio))
  const jitter = (random() * 0.2 - 0.1) * lead
  const at = (cur.exp - lead + jitter) * 1000
  return Math.max(1000, at - nowMs)
}

/**
 * Owns the credentials of one connection: fetches them before connect, serves them to the
 * client on every (re)connect, refreshes them ahead of expiry and asks for a reconnect when
 * they change. On failure it keeps the last good credentials and retries with backoff.
 */
export class CredentialManager {
  readonly provider: NatsCredentialsProvider
  private readonly opts: Required<RefreshOptions>
  private readonly events: CredentialManagerEvents
  private current?: Current
  private status: CredentialsStatus = 'pending'
  private timer?: ReturnType<typeof setTimeout>
  private nextRefreshAt?: number
  private lastRefreshAt?: number
  private lastErrorCode?: string
  private lastReconnectAt = 0
  private lastAuthErrorRefreshAt = 0
  private failures = 0
  private inflight?: Promise<boolean>
  private reconnect?: () => Promise<void>
  private readonly abort = new AbortController()
  private disposed = false

  constructor(provider: NatsCredentialsProvider, opts: RefreshOptions = {}, events: CredentialManagerEvents = {}) {
    this.provider = provider
    // Unset runtimeConfig values arrive as '' or 0; keep the defaults for those.
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => typeof v === 'number' && v > 0))
    this.opts = { ...DEFAULTS, ...given }
    this.events = events
  }

  /** Fetch the first credentials, retrying with backoff until `initTimeoutSec`. */
  async init(): Promise<void> {
    const deadline = Date.now() + this.opts.initTimeoutSec * 1000
    let delay = 1000
    for (;;) {
      if (await this.refresh('initial')) return
      if (this.disposed) throw new Error('[nuxt-nats] credentials manager disposed during init')
      // A retry that would start at or past the deadline is not attempted.
      if (Date.now() + delay >= deadline) {
        this.status = 'failed'
        throw new CredentialsProviderError(this.provider.name, this.lastErrorCode ?? 'unavailable', `no credentials after ${this.opts.initTimeoutSec}s`)
      }
      await sleep(delay, this.abort.signal)
      delay = Math.min(delay * 2, this.opts.maxBackoffSec * 1000)
    }
  }

  /** The client authenticator. Reads the current credentials on every (re)connect. */
  authenticator(): Authenticator {
    return (nonce?: string) => {
      const cur = this.current
      if (!cur) throw new Error('[nuxt-nats] no NATS credentials loaded yet')
      return jwtAuthenticator(cur.jwt, cur.seed)(nonce)
    }
  }

  /** Start scheduled refreshes; `reconnect` applies changed credentials to the live connection. */
  attach(reconnect: () => Promise<void>): void {
    this.reconnect = reconnect
    this.schedule()
  }

  /** Refresh now, e.g. after the server rejected the credentials. Rate-limited and single-flight. */
  refreshNow(reason: CredentialsFetchContext['reason'] = 'auth-error'): Promise<boolean> {
    if (reason === 'auth-error') {
      const now = Date.now()
      if (now - this.lastAuthErrorRefreshAt < MIN_AUTH_ERROR_REFRESH_MS) return this.inflight ?? Promise.resolve(false)
      this.lastAuthErrorRefreshAt = now
    }
    return this.refresh(reason).then((ok) => {
      this.schedule()
      return ok
    })
  }

  snapshot(nowMs = Date.now()): CredentialsSnapshot {
    const secs = (ms?: number) => (ms === undefined ? null : Math.max(0, Math.round((ms - nowMs) / 1000)))
    return {
      provider: this.provider.name,
      status: this.effectiveStatus(nowMs),
      expiresInSec: this.current?.exp ? secs(this.current.exp * 1000) : null,
      nextRefreshInSec: secs(this.nextRefreshAt),
      lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
      lastErrorCode: this.lastErrorCode ?? null,
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.abort.abort()
    try {
      await this.provider.dispose?.()
    }
    catch (err) {
      console.error(`[nuxt-nats] Error disposing credentials provider "${this.provider.name}": ${describeError(err)}`)
    }
  }

  private effectiveStatus(nowMs: number): CredentialsStatus {
    if (this.status === 'ok' && this.current?.exp && this.current.exp * 1000 <= nowMs) return 'expired'
    return this.status
  }

  /** One fetch, single-flight. Resolves true when usable credentials were loaded. */
  private refresh(reason: CredentialsFetchContext['reason']): Promise<boolean> {
    if (this.inflight) return this.inflight
    this.inflight = this.doRefresh(reason).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async doRefresh(reason: CredentialsFetchContext['reason']): Promise<boolean> {
    if (this.disposed) return false
    try {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      const next = normalizeCredentials(this.provider.name, await this.provider.fetch({ reason, signal }))
      if (next.exp && next.exp * 1000 <= Date.now()) {
        throw new CredentialsProviderError(this.provider.name, 'expired-credentials', 'returned credentials that have already expired')
      }
      const changed = next.fingerprint !== this.current?.fingerprint
      if (!changed && reason === 'scheduled' && next.exp) {
        // A scheduled refresh runs inside the lead window: unchanged credentials mean the
        // store has not been rotated and the connection will drop at expiry.
        console.warn(`[nuxt-nats] Credentials from "${this.provider.name}" are unchanged and expire in ${Math.round((next.exp * 1000 - Date.now()) / 1000)}s — is rotation running?`)
      }
      this.current = next
      this.status = 'ok'
      this.failures = 0
      this.lastErrorCode = undefined
      this.lastRefreshAt = Date.now()
      if (changed && reason !== 'initial') this.applyChange()
      this.fire(() => this.events.onRefreshed?.({ expiresAt: next.exp, changed }))
      return true
    }
    catch (err) {
      if (this.disposed) return false
      this.failures++
      this.lastErrorCode = err instanceof CredentialsProviderError ? err.code : 'error'
      if (this.current) this.status = this.current.exp && this.current.exp * 1000 <= Date.now() ? 'expired' : 'stale'
      console.error(`[nuxt-nats] Credentials refresh failed (${reason}, attempt ${this.failures}): ${describeError(err)}`)
      this.fire(() => this.events.onError?.(err instanceof Error ? err : new Error(String(err))))
      return false
    }
  }

  /** New credentials only take effect at the next connect, so force one (rate-limited). */
  private applyChange() {
    if (!this.reconnect) return
    const now = Date.now()
    if (now - this.lastReconnectAt < MIN_RECONNECT_INTERVAL_MS) return
    this.lastReconnectAt = now
    this.reconnect().catch((err) => {
      console.error(`[nuxt-nats] Reconnect with refreshed credentials failed: ${describeError(err)}`)
    })
  }

  private schedule() {
    if (this.disposed || !this.reconnect) return
    if (this.timer) clearTimeout(this.timer)
    let delay: number
    if (this.failures > 0) {
      delay = Math.min(1000 * 2 ** (this.failures - 1), this.opts.maxBackoffSec * 1000)
    }
    else if (this.current) {
      delay = refreshDelayMs(this.current, Date.now(), this.opts)
    }
    else {
      delay = 1000
    }
    this.nextRefreshAt = Date.now() + delay
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh('scheduled').then(() => this.schedule())
    }, delay)
    // Never keep the process alive just to refresh credentials.
    this.timer.unref?.()
  }

  private fire(fn: () => void) {
    try {
      fn()
    }
    catch {
      // hook errors never affect the manager
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })
}

// The manager of the running connection, for the health endpoint.
let _active: CredentialManager | undefined

export function getCredentialManager(): CredentialManager | undefined {
  return _active
}
export function setCredentialManager(m: CredentialManager | undefined) {
  _active = m
}
