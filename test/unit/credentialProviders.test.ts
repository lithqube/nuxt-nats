import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { infisicalProvider, infisicalLoginBody, credentialsFromSecret } from '../../src/runtime/server/credentials/providers/infisical'
import { synadiaProvider } from '../../src/runtime/server/credentials/providers/synadia'
import { createCredentialsProvider } from '../../src/runtime/server/credentials'
import { CredentialsProviderError } from '../../src/runtime/server/credentials/types'
import { redact } from '../../src/runtime/server/credentials/redact'
import { generateProviderModule, CREDENTIALS_PROVIDER_ID } from '../../src/providerTemplate'

const signal = new AbortController().signal
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const base = {
  projectId: 'proj',
  environment: 'prod',
  secretName: 'NATS_CREDS',
  auth: { method: 'universal' as const, clientId: 'cid', clientSecret: 'csecret' },
}

describe('infisical provider', () => {
  it('logs in, reads the secret and caches the access token', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ accessToken: 'at-1', expiresIn: 3600 }))
      .mockImplementation(async () => json({ secret: { secretValue: 'CREDS' } }))
    vi.stubGlobal('fetch', fetch)
    const p = infisicalProvider({ ...base, secretPath: '/nats' })

    expect(await p.fetch({ reason: 'initial', signal })).toEqual({ creds: 'CREDS' })
    await p.fetch({ reason: 'scheduled', signal })

    expect(fetch).toHaveBeenCalledTimes(3) // one login, two reads
    const [loginUrl, loginInit] = fetch.mock.calls[0]!
    expect(loginUrl).toBe('https://app.infisical.com/api/v1/auth/universal-auth/login')
    expect(JSON.parse(loginInit.body)).toEqual({ clientId: 'cid', clientSecret: 'csecret' })
    const [readUrl, readInit] = fetch.mock.calls[1]!
    expect(readUrl).toBe('https://app.infisical.com/api/v4/secrets/NATS_CREDS?projectId=proj&environment=prod&secretPath=%2Fnats')
    expect(readInit.headers.Authorization).toBe('Bearer at-1')
  })

  it('logs in again after the secret read returns 401', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ accessToken: 'at-1', expiresIn: 3600 }))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ accessToken: 'at-2', expiresIn: 3600 }))
      .mockResolvedValueOnce(json({ secret: { secretValue: 'CREDS' } }))
    vi.stubGlobal('fetch', fetch)
    const p = infisicalProvider(base)
    await expect(p.fetch({ reason: 'initial', signal })).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(await p.fetch({ reason: 'initial', signal })).toEqual({ creds: 'CREDS' })
    expect(fetch.mock.calls[3]![1].headers.Authorization).toBe('Bearer at-2')
  })

  it('never puts a response body in the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"bad clientSecret csecret"}', { status: 401 })))
    const err = await infisicalProvider(base).fetch({ reason: 'initial', signal }).catch(e => e)
    expect(err).toBeInstanceOf(CredentialsProviderError)
    expect(err.message).toContain('HTTP 401')
    expect(err.message).not.toContain('csecret')
  })

  it('rejects an empty secret', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ accessToken: 'at', expiresIn: 3600 }))
      .mockResolvedValueOnce(json({ secret: { secretValue: '' } })))
    await expect(infisicalProvider(base).fetch({ reason: 'initial', signal })).rejects.toMatchObject({ code: 'empty-secret' })
  })

  it('validates its configuration up front', () => {
    expect(() => infisicalProvider({ ...base, projectId: '' })).toThrow(/projectId is required/)
    expect(() => infisicalProvider({ ...base, auth: { method: 'universal', clientId: 'x' } })).toThrow(/clientId and clientSecret/)
    expect(() => infisicalProvider({ ...base, auth: { method: 'kubernetes' } })).toThrow(/needs identityId/)
    expect(() => infisicalProvider({ ...base, auth: { method: 'oidc', identityId: 'i' } })).toThrow(/jwt or tokenPath/)
  })

  it('builds kubernetes and oidc logins from a token file or value', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuxt-nats-')), 'token')
    writeFileSync(file, 'k8s-jwt\n')
    expect(infisicalLoginBody({ method: 'kubernetes', identityId: 'id', tokenPath: file })).toEqual({
      path: '/api/v1/auth/kubernetes-auth/login',
      body: { identityId: 'id', jwt: 'k8s-jwt' },
    })
    expect(infisicalLoginBody({ method: 'oidc', identityId: 'id', jwt: 'oidc-jwt' })).toEqual({
      path: '/api/v1/auth/oidc-auth/login',
      body: { identityId: 'id', jwt: 'oidc-jwt' },
    })
    expect(() => infisicalLoginBody({ method: 'kubernetes', identityId: 'id', tokenPath: '/nope' })).toThrow(/cannot read the identity token file/)
  })

  it('treats a bare JWT secret as a bearer user', () => {
    expect(credentialsFromSecret(' eyJa.eyJb.c ')).toEqual({ userJwt: 'eyJa.eyJb.c' })
    expect(credentialsFromSecret('LS0tLS1CRUdJTg==')).toEqual({ creds: 'LS0tLS1CRUdJTg==' })
  })
})

describe('synadia provider', () => {
  it('issues creds for the configured user', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('CREDS'))
    vi.stubGlobal('fetch', fetch)
    const p = synadiaProvider({ userId: 'u 1', token: 'sat_x' })
    expect(await p.fetch({ reason: 'initial', signal })).toEqual({ creds: 'CREDS' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://cloud.synadia.com/api/core/beta/nats-users/u%201/creds')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sat_x')
  })

  it('maps 403 to forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    await expect(synadiaProvider({ userId: 'u', token: 't' }).fetch({ reason: 'initial', signal })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('requires userId and token', () => {
    expect(() => synadiaProvider({ userId: '', token: 't' })).toThrow(/userId is required/)
    expect(() => synadiaProvider({ userId: 'u', token: '' })).toThrow(/NUXT_NATS_CREDENTIALS_SYNADIA_TOKEN/)
  })
})

describe('createCredentialsProvider', () => {
  it('returns undefined for static (the default)', () => {
    expect(createCredentialsProvider(undefined, undefined)).toBeUndefined()
    expect(createCredentialsProvider({ provider: '' }, undefined)).toBeUndefined()
  })

  it('builds infisical and synadia providers from runtime config', () => {
    expect(createCredentialsProvider({ provider: 'infisical', infisical: { ...base, auth: { ...base.auth, method: '' } } }, undefined)?.name).toBe('infisical')
    expect(createCredentialsProvider({ provider: 'synadia', synadia: { userId: 'u', token: 't' } }, undefined)?.name).toBe('synadia')
  })

  it('requires a custom provider module when provider is custom', () => {
    expect(() => createCredentialsProvider({ provider: 'custom' }, undefined)).toThrow(/customProvider must default-export/)
    const custom = { name: 'mine', fetch: async () => ({ userJwt: 'x' }) }
    expect(createCredentialsProvider({ provider: 'custom' }, custom)).toBe(custom)
  })

  it('rejects an unknown kind', () => {
    expect(() => createCredentialsProvider({ provider: 'vault' as never }, undefined)).toThrow(/unknown credentials provider "vault"/)
  })
})

describe('redact', () => {
  it('removes JWTs, seeds, Synadia and Infisical tokens and PEM bodies', () => {
    const seed = `SUA${'A'.repeat(55)}`
    const text = `jwt eyJhbGc.eyJzdWI.sig seed ${seed} pat uat_abc123 inf st.abcdefghijklmnopqrstuvwxyz pem -----BEGIN PRIVATE KEY-----\nMIIabc+/=\n-----END PRIVATE KEY-----`
    const out = redact(text)
    for (const secret of ['eyJhbGc', seed, 'uat_abc123', 'st.abcdef', 'MIIabc']) expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })

  it('leaves ordinary text alone', () => {
    expect(redact('GET /api/v4/secrets returned HTTP 401')).toBe('GET /api/v4/secrets returned HTTP 401')
  })
})

describe('generateProviderModule', () => {
  it('re-exports the provider file, safely quoted', () => {
    expect(generateProviderModule('/srv/server/nats/creds\'s.ts')).toBe('export { default } from "/srv/server/nats/creds\'s.ts"\n')
  })

  it('exports undefined without a provider', () => {
    expect(generateProviderModule()).toBe('export default undefined\n')
    expect(CREDENTIALS_PROVIDER_ID).toBe('#nuxt-nats/credentials-provider')
  })
})
