import { describe, it, expect, vi, afterEach } from 'vitest'
import { createUser } from '@nats-io/nkeys'

// The rotator's built-in --verify: connect with the new creds, flush, close.
const nats = vi.hoisted(() => ({ opts: undefined as Record<string, unknown> | undefined, flush: vi.fn(), close: vi.fn() }))
vi.mock('@nats-io/transport-node', () => ({
  connect: vi.fn(async (opts: Record<string, unknown>) => {
    nats.opts = opts
    return { flush: nats.flush, close: nats.close }
  }),
}))

const { runRotate } = await import('../../src/runtime/cli/rotate')

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = `${b64url({ alg: 'ed25519-nkey' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const seed = new TextDecoder().decode(createUser().getSeed())
const creds = `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`

afterEach(() => {
  vi.unstubAllGlobals()
  nats.flush.mockReset()
  nats.close.mockReset()
})

function cp() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/creds')
    ? new Response(creds)
    : new Response(JSON.stringify({ id: 'u1', user_public_key: 'U', jwt_expires_in_secs: 3600, account: { id: 'a1' } }))))
}
const run = () => runRotate(['--user-id', 'u1', '--store', 'module:test/fixtures/credentials/empty-store.mjs', '--dry-run', '--verify', '--servers', 'tls://a:4222,tls://b:4222'], {
  env: { SYNADIA_CLOUD_TOKEN: 't' },
  out: () => {},
  err: () => {},
})

describe('rotator --verify (built-in)', () => {
  it('connects with the new creds without reconnecting, then flushes and closes', async () => {
    cp()
    const { code } = await run()
    expect(code).toBe(0)
    expect(nats.opts).toMatchObject({ servers: ['tls://a:4222', 'tls://b:4222'], reconnect: false, name: 'nuxt-nats-rotate' })
    expect((nats.opts!.authenticator as (n: string) => { jwt: string })('nonce').jwt).toBe(jwt)
    expect(nats.flush).toHaveBeenCalledOnce()
    expect(nats.close).toHaveBeenCalledOnce()
  })

  it('closes the connection even when the flush fails, and reports verify-failed', async () => {
    cp()
    nats.flush.mockRejectedValueOnce(new Error('Permissions Violation'))
    const { code, result } = await run()
    expect(code).toBe(1)
    expect(result.code).toBe('verify-failed')
    expect(nats.close).toHaveBeenCalledOnce()
  })
})
