import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSynadiaClient, SynadiaApiError } from '../../src/runtime/synadia/client'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function stub(...responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => {
    const r = responses.length > 1 ? responses.shift()! : responses[0]!
    if (r instanceof Error) throw r
    return r.clone()
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const client = (o = {}) => createSynadiaClient({ token: 'sat_test', ...o })
const B = 'https://cloud.synadia.com/api/core/beta'

describe('createSynadiaClient — requests', () => {
  it.each([
    ['listTeams', (c: ReturnType<typeof client>) => c.listTeams(), 'GET', '/teams'],
    ['listSystems', (c: ReturnType<typeof client>) => c.listSystems('t1'), 'GET', '/teams/t1/systems'],
    ['listAccounts', (c: ReturnType<typeof client>) => c.listAccounts('s1'), 'GET', '/systems/s1/accounts'],
    ['natsUsers.list', (c: ReturnType<typeof client>) => c.natsUsers.list('a1'), 'GET', '/accounts/a1/nats-users'],
    ['natsUsers.listIssuances', (c: ReturnType<typeof client>) => c.natsUsers.listIssuances('u1'), 'GET', '/nats-users/u1/issuances'],
    ['streams.list', (c: ReturnType<typeof client>) => c.streams.list('a1'), 'GET', '/accounts/a1/jetstream/streams'],
    ['kvBuckets.list', (c: ReturnType<typeof client>) => c.kvBuckets.list('a1'), 'GET', '/accounts/a1/jetstream/kv-buckets'],
  ])('%s unwraps { items }', async (_n, fn, method, path) => {
    const fetch = stub(json({ items: [{ id: 'x' }] }))
    expect(await fn(client())).toEqual([{ id: 'x' }])
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe(`${B}${path}`)
    expect(init.method).toBe(method)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sat_test')
  })

  it('returns an empty list when items is missing', async () => {
    stub(json({}))
    expect(await client().listTeams()).toEqual([])
  })

  it('issues creds and bearer JWTs as text', async () => {
    const fetch = stub(new Response('-----BEGIN NATS USER JWT-----'))
    expect(await client().natsUsers.issueCreds('u 1')).toBe('-----BEGIN NATS USER JWT-----')
    await client().natsUsers.issueBearerJwt('u1')
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0]![0]).toBe(`${B}/nats-users/u%201/creds`)
    expect(calls[0]![1].method).toBe('POST')
    expect((calls[0]![1].headers as Record<string, string>).Accept).toBe('text/plain')
    expect(calls[1]![0]).toBe(`${B}/nats-users/u1/bearer-jwt`)
  })

  it('creates a user, filling the limits the API requires', async () => {
    const fetch = stub(json({ id: 'u1' }))
    await client().natsUsers.create('a1', { name: 'app', sk_group_id: 'g1', jwt_expires_in_secs: 3600, jwt_settings: { pub: { allow: ['app.>'] } } })
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ name: 'app', sk_group_id: 'g1', jwt_expires_in_secs: 3600, jwt_settings: { data: -1, payload: -1, subs: -1, pub: { allow: ['app.>'] } } })
  })

  it('creates a user without jwt_settings untouched', async () => {
    const fetch = stub(json({ id: 'u1' }))
    await client().natsUsers.create('a1', { name: 'app', sk_group_id: 'g1' })
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ name: 'app', sk_group_id: 'g1' })
  })

  it('revokes with a `before` timestamp and unrevokes', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const fetch = stub(json({ before: 1 }), new Response(null, { status: 204 }))
    await client().natsUsers.revoke('a1', 'UOLD')
    expect(await client().natsUsers.unrevoke('a1', 'UOLD')).toBeUndefined()
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0]![0]).toBe(`${B}/accounts/a1/nats-user-revocations/UOLD`)
    expect(calls[0]![1].method).toBe('PUT')
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ before: 1_800_000_000 })
    expect(calls[1]![1].method).toBe('DELETE')
  })

  it('manages streams and KV buckets', async () => {
    const fetch = stub(json({ id: 's1' }))
    const c = client()
    await c.streams.create('a1', { name: 'ORDERS', subjects: ['orders.>'] })
    await c.streams.get('s1')
    await c.streams.update('s1', { subjects: ['orders.>', 'refunds.>'] })
    await c.streams.delete('s1')
    await c.kvBuckets.create('a1', { bucket: 'cfg' })
    await c.kvBuckets.delete('k1')
    await c.getAccount('a1')
    await c.natsUsers.get('u1')
    await c.natsUsers.rotate('u1')
    const calls = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).map(([u, i]) => `${i.method} ${u.replace(B, '')}`)
    expect(calls).toEqual([
      'POST /accounts/a1/jetstream/streams',
      'GET /jetstream/stream/s1',
      'PATCH /jetstream/stream/s1',
      'DELETE /jetstream/stream/s1',
      'POST /accounts/a1/jetstream/kv-buckets',
      'DELETE /jetstream/kv-bucket/k1',
      'GET /accounts/a1',
      'GET /nats-users/u1',
      'POST /nats-users/u1/rotate',
    ])
    const kvBody = JSON.parse((fetch.mock.calls[4] as unknown as [string, RequestInit])[1].body as string)
    expect(kvBody).toEqual({ history: 1, storage: 'file', num_replicas: 1, compression: false, bucket: 'cfg' })
  })

  it('passes connection filters as query parameters', async () => {
    const fetch = stub(json({ items: [] }))
    await client().listConnections('a1', { limit: 10, state: 'open', user: '' })
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(`${B}/accounts/a1/connections?limit=10&state=open`)
  })

  it('uses a custom API URL', async () => {
    const fetch = stub(json({ items: [] }))
    await client({ apiUrl: 'https://cp.internal/api/' }).listTeams()
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://cp.internal/api/core/beta/teams')
  })

  it('requires a token', () => {
    expect(() => createSynadiaClient({ token: '' })).toThrow(SynadiaApiError)
  })
})

describe('createSynadiaClient — errors and retries', () => {
  it('maps statuses to codes, without the response body', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [409, 'conflict'], [400, 'http-error']] as const) {
      stub(new Response('{"error":"token sat_test is invalid"}', { status }))
      const err = await client({ retries: 0 }).getAccount('a1').catch(e => e)
      expect(err).toBeInstanceOf(SynadiaApiError)
      expect(err).toMatchObject({ code, status, operation: 'getAccount' })
      expect(err.message).not.toContain('sat_test')
    }
  })

  it('retries a 429 honoring Retry-After, even for a POST', async () => {
    vi.useFakeTimers()
    const fetch = stub(json({}, 429, { 'Retry-After': '2' }), new Response('CREDS'))
    const p = client().natsUsers.issueCreds('u1')
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toBe('CREDS')
  })

  it('retries gateway errors and network failures for safe methods only', async () => {
    vi.useFakeTimers()
    const get = stub(new Response('', { status: 503 }), new TypeError('fetch failed'), json({ id: 'a1' }))
    const p = client().getAccount('a1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toEqual({ id: 'a1' })
    expect(get).toHaveBeenCalledTimes(3)

    const post = stub(new Response('', { status: 503 }), json({ id: 'u1' }))
    await expect(client().natsUsers.create('a1', { name: 'x', sk_group_id: 'g' })).rejects.toMatchObject({ status: 503 })
    expect(post).toHaveBeenCalledTimes(1) // a create is never repeated after the server may have run it
  })

  it('gives up after `retries` and reports a network failure', async () => {
    vi.useFakeTimers()
    stub(new TypeError('fetch failed'))
    const p = client({ retries: 1 }).listTeams().catch(e => e)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toMatchObject({ code: 'network', operation: 'listTeams' })
  })

  it('reports a timeout', async () => {
    stub(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    await expect(client({ retries: 0 }).listTeams()).rejects.toMatchObject({ code: 'timeout' })
  })
})
