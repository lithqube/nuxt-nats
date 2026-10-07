import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createUser } from '@nats-io/nkeys'
import {
  CredentialManager,
  normalizeCredentials,
  refreshDelayMs,
} from '../../src/runtime/server/credentials/manager'
import { CredentialsProviderError } from '../../src/runtime/server/credentials/types'
import type { NatsCredentials, NatsCredentialsProvider } from '../../src/runtime/server/credentials/types'

// The manager only decodes JWTs, so unsigned test JWTs carrying iat/exp are enough.
function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ typ: 'JWT', alg: 'ed25519-nkey' })}.${b(claims)}.sig`
}
const seed = new TextDecoder().decode(createUser().getSeed())
const nowSec = () => Math.floor(Date.now() / 1000)

function creds(j: string) {
  return `-----BEGIN NATS USER JWT-----\n${j}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`
}

/** A provider that returns queued results; an Error in the queue is thrown. */
function queueProvider(...results: Array<NatsCredentials | Error>): NatsCredentialsProvider & { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => {
    const next = results.length > 1 ? results.shift()! : results[0]!
    if (next instanceof Error) throw next
    return next
  })
  return { name: 'test', fetch }
}

const DEFAULTS = { leadRatio: 0.2, minLeadSec: 60, maxLeadSec: 3600, pollSec: 300, maxBackoffSec: 60, initTimeoutSec: 30 }

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('normalizeCredentials', () => {
  it('reads a creds file and its expiry', () => {
    const exp = nowSec() + 3600
    const c = normalizeCredentials('p', { creds: creds(jwt({ iat: exp - 7200, exp })) })
    expect(c.exp).toBe(exp)
    expect(c.iat).toBe(exp - 7200)
    expect(c.seed).toBeInstanceOf(Uint8Array)
  })

  it('accepts base64 creds and a bearer JWT', () => {
    const j = jwt({ exp: nowSec() + 60 })
    expect(normalizeCredentials('p', { creds: Buffer.from(creds(j)).toString('base64') }).jwt).toBe(j)
    const bearer = normalizeCredentials('p', { userJwt: j })
    expect(bearer.jwt).toBe(j)
    expect(bearer.seed).toBeUndefined()
  })

  it('lets expiresAt override the JWT claim', () => {
    expect(normalizeCredentials('p', { userJwt: jwt({ exp: 1 }), expiresAt: 99 }).exp).toBe(99)
  })

  it('fingerprints JWT + seed so identical credentials compare equal', () => {
    const j = jwt({ exp: nowSec() + 60 })
    expect(normalizeCredentials('p', { creds: creds(j) }).fingerprint).toBe(normalizeCredentials('p', { creds: creds(j) }).fingerprint)
    expect(normalizeCredentials('p', { userJwt: j }).fingerprint).not.toBe(normalizeCredentials('p', { creds: creds(j) }).fingerprint)
  })

  it('rejects a non-creds value without echoing it', () => {
    let err: unknown
    try {
      normalizeCredentials('p', { creds: 'SUAXTOPSECRET' })
    }
    catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CredentialsProviderError)
    expect((err as CredentialsProviderError).code).toBe('bad-credentials')
    expect((err as Error).message).not.toContain('TOPSECRET')
  })

  it('rejects an empty result', () => {
    expect(() => normalizeCredentials('p', {})).toThrow(/neither creds nor userJwt/)
  })
})

describe('refreshDelayMs', () => {
  const now = 1_000_000_000_000
  const at = (sec: number) => now / 1000 + sec

  it('refreshes 20% of the lifetime before expiry, capped at maxLeadSec', () => {
    // 6h lifetime → 72 min lead, capped at 60 min; no jitter at random() = 0.5
    const d = refreshDelayMs({ iat: at(0), exp: at(6 * 3600) }, now, DEFAULTS, () => 0.5)
    expect(d).toBe((6 * 3600 - 3600) * 1000)
  })

  it('never leads by less than minLeadSec', () => {
    // 2 min lifetime → 24s lead, raised to 60s
    expect(refreshDelayMs({ iat: at(0), exp: at(120) }, now, DEFAULTS, () => 0.5)).toBe(60_000)
  })

  it('stays within ±10% of the lead', () => {
    const cur = { iat: at(0), exp: at(10_000) } // lead 2000s
    const lo = refreshDelayMs(cur, now, DEFAULTS, () => 0)
    const hi = refreshDelayMs(cur, now, DEFAULTS, () => 0.999999)
    expect(lo).toBe((10_000 - 2000 - 200) * 1000)
    expect(hi).toBeCloseTo((10_000 - 2000 + 200) * 1000, -2)
  })

  it('polls credentials that do not expire', () => {
    expect(refreshDelayMs({}, now, DEFAULTS)).toBe(300_000)
  })

  it('is at least one second, even when already inside the lead', () => {
    expect(refreshDelayMs({ iat: at(-100), exp: at(10) }, now, DEFAULTS)).toBe(1000)
  })
})

describe('CredentialManager', () => {
  it('loads credentials on init and serves them to the authenticator', async () => {
    const j = jwt({ exp: nowSec() + 3600 })
    const m = new CredentialManager(queueProvider({ creds: creds(j) }))
    expect(() => m.authenticator()('nonce')).toThrow(/no NATS credentials/)
    await m.init()
    const auth = m.authenticator()('nonce') as { jwt: string, nkey: string, sig: string }
    expect(auth.jwt).toBe(j)
    expect(auth.sig).toBeTruthy()
    expect(m.snapshot().status).toBe('ok')
    await m.dispose()
  })

  it('retries init with backoff, then succeeds', async () => {
    vi.useFakeTimers()
    const p = queueProvider(new Error('down'), new Error('down'), { creds: creds(jwt({ exp: nowSec() + 3600 })) })
    const m = new CredentialManager(p)
    const done = m.init()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await done
    expect(p.fetch).toHaveBeenCalledTimes(3)
    await m.dispose()
  })

  it('fails init after initTimeoutSec with the last error code', async () => {
    vi.useFakeTimers()
    const p = queueProvider(new CredentialsProviderError('test', 'unauthorized', 'nope', { status: 401 }))
    const m = new CredentialManager(p, { initTimeoutSec: 5 })
    const done = m.init().catch(e => e)
    await vi.advanceTimersByTimeAsync(10_000)
    const err = await done
    expect(err).toBeInstanceOf(CredentialsProviderError)
    expect(err.code).toBe('unauthorized')
    expect(m.snapshot().status).toBe('failed')
    await m.dispose()
  })

  it('runs one fetch for concurrent refreshes (single-flight)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const j = jwt({ exp: nowSec() + 3600 })
    const fetch = vi.fn(async () => {
      await gate
      return { creds: creds(j) }
    })
    const m = new CredentialManager({ name: 'test', fetch })
    const a = m.refreshNow('scheduled')
    const b = m.refreshNow('scheduled')
    release()
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(fetch).toHaveBeenCalledTimes(1)
    await m.dispose()
  })

  it('reconnects when the credentials change, not when they are the same', async () => {
    const j1 = jwt({ exp: nowSec() + 3600, jti: '1' })
    const j2 = jwt({ exp: nowSec() + 3600, jti: '2' })
    const p = queueProvider({ creds: creds(j1) }, { creds: creds(j1) }, { creds: creds(j2) })
    const m = new CredentialManager(p)
    await m.init()
    const reconnect = vi.fn(async () => {})
    m.attach(reconnect)

    await m.refreshNow('scheduled') // same
    expect(reconnect).not.toHaveBeenCalled()
    await m.refreshNow('scheduled') // changed
    expect(reconnect).toHaveBeenCalledOnce()
    expect((m.authenticator()('n') as { jwt: string }).jwt).toBe(j2)
    await m.dispose()
  })

  it('keeps the last good credentials when a refresh fails', async () => {
    const j = jwt({ exp: nowSec() + 3600 })
    const p = queueProvider({ creds: creds(j) }, new CredentialsProviderError('test', 'rate-limited', 'slow down', { status: 429 }))
    const onError = vi.fn()
    const m = new CredentialManager(p, {}, { onError })
    await m.init()
    expect(await m.refreshNow('scheduled')).toBe(false)
    expect((m.authenticator()('n') as { jwt: string }).jwt).toBe(j)
    expect(m.snapshot()).toMatchObject({ status: 'stale', lastErrorCode: 'rate-limited' })
    expect(onError).toHaveBeenCalledOnce()
    await m.dispose()
  })

  it('rejects credentials that have already expired', async () => {
    const m = new CredentialManager(queueProvider({ userJwt: jwt({ exp: nowSec() - 10 }) }), { initTimeoutSec: 1 })
    await expect(m.init()).rejects.toMatchObject({ code: 'expired-credentials' })
    await m.dispose()
  })

  it('rate-limits auth-error refreshes', async () => {
    const p = queueProvider({ creds: creds(jwt({ exp: nowSec() + 3600 })) })
    const m = new CredentialManager(p)
    await m.init()
    await m.refreshNow('auth-error')
    await m.refreshNow('auth-error')
    expect(p.fetch).toHaveBeenCalledTimes(2) // init + one auth-error refresh
    await m.dispose()
  })

  it('schedules the next refresh ahead of expiry and refreshes on time', async () => {
    vi.useFakeTimers()
    const j1 = jwt({ iat: nowSec(), exp: nowSec() + 600, jti: '1' })
    const j2 = jwt({ iat: nowSec(), exp: nowSec() + 1200, jti: '2' })
    const p = queueProvider({ creds: creds(j1) }, { creds: creds(j2) })
    const m = new CredentialManager(p)
    await m.init()
    m.attach(async () => {})
    // 600s lifetime → 120s lead (±12s jitter): refresh between 468s and 492s
    expect(m.snapshot().nextRefreshInSec).toBeGreaterThanOrEqual(468)
    expect(m.snapshot().nextRefreshInSec).toBeLessThanOrEqual(492)
    await vi.advanceTimersByTimeAsync(500_000)
    expect(p.fetch).toHaveBeenCalledTimes(2)
    await m.dispose()
  })

  it('reports expired once the current JWT is past exp', async () => {
    const exp = nowSec() + 3600
    const m = new CredentialManager(queueProvider({ creds: creds(jwt({ exp })) }))
    await m.init()
    expect(m.snapshot((exp + 1) * 1000).status).toBe('expired')
    await m.dispose()
  })

  it('snapshot carries no identities or secrets', async () => {
    const j = jwt({ exp: nowSec() + 3600, sub: 'UABCDEFGH' })
    const m = new CredentialManager(queueProvider({ creds: creds(j) }))
    await m.init()
    const json = JSON.stringify(m.snapshot())
    expect(json).not.toContain(j)
    expect(json).not.toContain(seed)
    expect(json).not.toContain('UABCDEFGH')
    expect(Object.keys(m.snapshot()).sort()).toEqual(['expiresInSec', 'lastErrorCode', 'lastRefreshAt', 'nextRefreshInSec', 'provider', 'status'])
    await m.dispose()
  })

  it('dispose stops scheduled refreshes and disposes the provider', async () => {
    vi.useFakeTimers()
    const dispose = vi.fn()
    const p = { ...queueProvider({ creds: creds(jwt({})) }), dispose }
    const m = new CredentialManager(p, { pollSec: 10 })
    await m.init()
    m.attach(async () => {})
    await m.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(p.fetch).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledOnce()
  })
})
