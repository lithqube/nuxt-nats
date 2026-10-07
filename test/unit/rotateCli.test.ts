import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { createUser } from '@nats-io/nkeys'
import { runRotate } from '../../src/runtime/cli/rotate'

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'ed25519-nkey' })}.${b64url(claims)}.sig`
const seed = new TextDecoder().decode(createUser().getSeed())
const creds = (j: string) => `-----BEGIN NATS USER JWT-----\n${j}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`
const NOW = 1_800_000_000_000
const sec = (s: number) => NOW / 1000 + s

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const user = (key = 'UOLDKEY', ttl = 3600) => ({ id: 'u1', name: 'app', user_public_key: key, jwt_expires_in_secs: ttl, account: { id: 'a1' } })

/** Control Plane (and optionally Infisical) as a routed fetch mock. */
function api(routes: Record<string, () => Response>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find(k => `${init?.method ?? 'GET'} ${url}`.startsWith(k))
    if (!key) return new Response('', { status: 404 })
    return routes[key]!()
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const CP = 'https://cloud.synadia.com/api/core/beta'
const issued = jwt({ iat: sec(0), exp: sec(3600), jti: 'new' })

function run(argv: string[], env: Record<string, string> = {}, verify?: () => Promise<void>) {
  const out: string[] = []
  const err: string[] = []
  return runRotate(argv, { env: { SYNADIA_CLOUD_TOKEN: 'sat_secret', ...env }, out: l => out.push(l), err: l => err.push(l), now: () => NOW, verify })
    .then(r => ({ ...r, out, err, json: JSON.parse(out[0] ?? '{}') }))
}

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuxt-nats-rotate-'))
  file = join(dir, 'app.creds')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('nuxt-nats-rotate — usage', () => {
  it.each([
    [[], {}, /--user-id/],
    [['--user-id', 'u1', '--revoke-old'], {}, /only applies with --rotate-nkey/],
    [['--user-id', 'u1', '--store', 'file'], {}, /needs --file/],
    [['--user-id', 'u1', '--store', 'vault'], {}, /unknown --store "vault"/],
    [['--user-id', 'u1', '--store', 'file', '--file', 'x', '--encoding', 'hex'], {}, /--encoding must be/],
    [['--user-id', 'u1', '--store', 'file', '--file', 'x', '--min-remaining', 'soon'], {}, /invalid --min-remaining/],
    [['--user-id', 'u1', '--token-file', '/nope'], {}, /cannot read --token-file/],
    [['--bogus'], {}, /Unknown option/],
  ])('%j exits 2', async (argv, env, message) => {
    const r = await run(argv as string[], env)
    expect(r.code).toBe(2)
    expect(r.json).toEqual({ action: 'error', code: 'usage' })
    expect(r.err.join('\n')).toMatch(message)
  })

  it('needs a token', async () => {
    const out: string[] = []
    const r = await runRotate(['--user-id', 'u1'], { env: {}, out: l => out.push(l), err: () => {} })
    expect(r.code).toBe(2)
  })

  it('prints help', async () => {
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    expect(r.err[0]).toContain('Usage: nuxt-nats-rotate')
  })
})

describe('nuxt-nats-rotate — file store', () => {
  it('skips while the stored creds have more than --min-remaining left', async () => {
    writeFileSync(file, creds(jwt({ exp: sec(7 * 3600) })))
    const fetch = api({})
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file])
    expect(r.code).toBe(0)
    expect(r.json).toEqual({ action: 'skipped', userId: 'u1', expiresAt: new Date(sec(7 * 3600) * 1000).toISOString() })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips creds that never expire unless forced', async () => {
    writeFileSync(file, creds(jwt({})))
    api({})
    expect((await run(['--user-id', 'u1', '--store', 'file', '--file', file])).json).toMatchObject({ action: 'skipped', expiresAt: null })
  })

  it('rotates when the stored creds are close to expiry, writing raw creds with mode 0600', async () => {
    writeFileSync(file, creds(jwt({ exp: sec(3600) })))
    api({
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file])
    expect(r.code).toBe(0)
    expect(r.json).toEqual({ action: 'rotated', userId: 'u1', expiresAt: new Date(sec(3600) * 1000).toISOString(), nkeyRotated: false, revokedOldKey: false })
    expect(readFileSync(file, 'utf8')).toBe(creds(issued))
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('rotates when nothing is stored yet, and replaces a corrupt value with a warning', async () => {
    api({
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    expect((await run(['--user-id', 'u1', '--store', 'file', '--file', file])).json.action).toBe('rotated')
    writeFileSync(file, 'garbage')
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file])
    expect(r.json.action).toBe('rotated')
    expect(r.json.warnings).toEqual(['the stored value is not a creds file; replacing it'])
  })

  it('--dry-run issues and verifies but stores nothing', async () => {
    writeFileSync(file, 'old')
    api({
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    const verify = vi.fn(async () => {})
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file, '--force', '--dry-run', '--verify'], {}, verify)
    expect(r.json.action).toBe('dry-run')
    expect(verify).toHaveBeenCalledWith(['tls://connect.ngs.global'], issued, seed)
    expect(readFileSync(file, 'utf8')).toBe('old')
  })

  it('does not store creds that fail verification', async () => {
    writeFileSync(file, 'old')
    api({
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file, '--force', '--verify', '--servers', 'tls://a, tls://b'], {}, async () => {
      throw new Error(`Authorization Violation for ${issued}`)
    })
    expect(r.code).toBe(1)
    expect(r.json).toEqual({ action: 'error', code: 'verify-failed' })
    expect(r.err.join('\n')).not.toContain(issued)
    expect(readFileSync(file, 'utf8')).toBe('old')
  })

  it('--rotate-nkey --revoke-old rotates the key, stores, then revokes the previous key', async () => {
    const fetch = api({
      [`GET ${CP}/nats-users/u1`]: () => json(user('UOLDKEY')),
      [`POST ${CP}/nats-users/u1/rotate`]: () => json(user('UNEWKEY')),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
      [`PUT ${CP}/accounts/a1/nats-user-revocations/UOLDKEY`]: () => json({ before: 1 }),
    })
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file, '--rotate-nkey', '--revoke-old'])
    expect(r.json).toMatchObject({ action: 'rotated', nkeyRotated: true, revokedOldKey: true })
    const order = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).map(([u, i]) => `${i?.method ?? 'GET'} ${u.replace(CP, '')}`)
    expect(order).toEqual(['GET /nats-users/u1', 'POST /nats-users/u1/rotate', 'POST /nats-users/u1/creds', 'PUT /accounts/a1/nats-user-revocations/UOLDKEY'])
  })

  it('warns when the user has no JWT expiry', async () => {
    api({
      [`GET ${CP}/nats-users/u1`]: () => json(user('U', 0)),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file])
    expect(r.json.warnings[0]).toMatch(/no JWT expiry/)
  })

  it('reports Control Plane failures with their code and no secret', async () => {
    api({ [`GET ${CP}/nats-users/u1`]: () => new Response('{"error":"sat_secret is not allowed"}', { status: 403 }) })
    const r = await run(['--user-id', 'u1', '--store', 'file', '--file', file])
    expect(r.code).toBe(1)
    expect(r.json).toEqual({ action: 'error', code: 'forbidden' })
    expect([...r.out, ...r.err].join('\n')).not.toContain('sat_secret')
  })

  it('reads the token from --token-file', async () => {
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'sat_from_file\n')
    const fetch = api({
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    await runRotate(['--user-id', 'u1', '--store', 'file', '--file', file, '--token-file', tokenFile], { env: {}, out: () => {}, err: () => {} })
    expect(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer sat_from_file')
  })
})

describe('nuxt-nats-rotate — Infisical and module stores', () => {
  const IF = 'https://app.infisical.com'
  const infisicalEnv = { INFISICAL_PROJECT_ID: 'p', INFISICAL_ENVIRONMENT: 'prod', INFISICAL_CLIENT_ID: 'cid', INFISICAL_CLIENT_SECRET: 'cs', SYNADIA_NATS_USER_ID: 'u1' }

  it('writes base64 creds to the Infisical secret (creating it when missing)', async () => {
    const fetch = api({
      [`POST ${IF}/api/v1/auth/universal-auth/login`]: () => json({ accessToken: 'at', expiresIn: 3600 }),
      [`GET ${IF}/api/v4/secrets/NATS_CREDS`]: () => json({}, 404),
      [`PATCH ${IF}/api/v4/secrets/NATS_CREDS`]: () => json({}, 404),
      [`POST ${IF}/api/v4/secrets/NATS_CREDS`]: () => json({ secret: { secretKey: 'NATS_CREDS' } }),
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    const r = await run([], infisicalEnv)
    expect(r.json.action).toBe('rotated')
    const create = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).find(([u, i]) => i?.method === 'POST' && u.endsWith('/api/v4/secrets/NATS_CREDS'))!
    const body = JSON.parse(create[1].body as string)
    expect(body).toMatchObject({ projectId: 'p', environment: 'prod', secretPath: '/' })
    expect(Buffer.from(body.secretValue, 'base64').toString()).toBe(creds(issued))
  })

  it('fails when an Infisical approval policy holds the write', async () => {
    api({
      [`POST ${IF}/api/v1/auth/universal-auth/login`]: () => json({ accessToken: 'at', expiresIn: 3600 }),
      [`GET ${IF}/api/v4/secrets/NATS_CREDS`]: () => json({}, 404),
      [`PATCH ${IF}/api/v4/secrets/NATS_CREDS`]: () => json({ approval: { id: 'ap1', status: 'open' } }),
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    const r = await run([], infisicalEnv)
    expect(r.code).toBe(1)
    expect(r.json.code).toBe('approval-required')
  })

  it('skips when the Infisical secret is fresh', async () => {
    api({
      [`POST ${IF}/api/v1/auth/universal-auth/login`]: () => json({ accessToken: 'at', expiresIn: 3600 }),
      [`GET ${IF}/api/v4/secrets/NATS_CREDS`]: () => json({ secret: { secretValue: Buffer.from(creds(jwt({ exp: sec(86400) }))).toString('base64') } }),
    })
    expect((await run([], infisicalEnv)).json.action).toBe('skipped')
  })

  it('loads a custom store module', async () => {
    const storeFile = join(dir, 'store.mjs')
    writeFileSync(storeFile, `let v; export default { name: 'mem', async read() { return v }, async write(x) { v = x; globalThis.__written = x } }`)
    api({
      [`GET ${CP}/nats-users/u1`]: () => json(user()),
      [`POST ${CP}/nats-users/u1/creds`]: () => new Response(creds(issued)),
    })
    const r = await run(['--user-id', 'u1', '--store', `module:${storeFile}`])
    expect(r.json.action).toBe('rotated')
    expect((globalThis as Record<string, unknown>).__written).toBe(creds(issued))
  })

  it('rejects a module that is not a store', async () => {
    const storeFile = join(dir, 'bad.mjs')
    writeFileSync(storeFile, 'export default {}')
    const r = await run(['--user-id', 'u1', '--store', `module:${storeFile}`])
    expect(r.code).toBe(1)
    expect(r.err.join('')).toMatch(/must default-export \{ read\(\), write\(value\) \}/)
  })
})
