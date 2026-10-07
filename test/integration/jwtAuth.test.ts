import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { connect } from '@nats-io/transport-node'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { createOperator, createAccount, createUser, encodeOperator, encodeAccount, encodeUser, fmtCreds } from '@nats-io/jwt'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { buildAuthOptions } from '../../src/runtime/server/utils/buildConnectionOptions'
import { CredentialManager } from '../../src/runtime/server/credentials/manager'

interface JwtAuthTestContext {
  container: StartedTestContainer
  servers: string
  userJwt: string
  nkeySeed: string
  badNkeySeed: string
  /** A `.creds` file for the valid user. */
  creds: string
  /** A `.creds` file for a user the account does not know (signed by another account). */
  foreignCreds: string
  /** JWT for a bearer-token user: authenticates without signing the nonce. */
  bearerJwt: string
  /** Issue a `.creds` file for the valid user's key, expiring `ttlSec` from now. */
  issueCreds: (ttlSec: number) => Promise<string>
}

let ctx: JwtAuthTestContext

beforeAll(async () => {
  const okp = createOperator()
  const skp = createAccount()
  const akp = createAccount()
  const ukp = createUser()
  const badUkp = createUser()

  const sJwt = await encodeAccount('SYS', skp, {
    limits: { conn: -1, subs: -1, data: -1, payload: -1, imports: -1, exports: -1, wildcards: true, leaf: -1 },
  }, { signer: okp })

  const aJwt = await encodeAccount('A', akp, {
    limits: {
      conn: -1, subs: -1, data: -1, payload: -1, imports: -1, exports: -1, wildcards: true, leaf: -1,
      mem_storage: -1,
      disk_storage: -1,
      streams: -1,
      consumer: -1,
    },
  }, { signer: okp })

  const uJwt = await encodeUser('U', ukp, akp, {
    pub: { allow: ['jwt.>', '_INBOX.>', '$JS.API.>'], deny: [] },
    sub: { allow: ['jwt.>', '_INBOX.>', '$JS.API.>'], deny: [] },
  })

  const bearerUkp = createUser()
  const bearerJwt = await encodeUser('BEARER', bearerUkp, akp, {
    bearer_token: true,
    pub: { allow: ['jwt.>'], deny: [] },
    sub: { allow: ['jwt.>', '_INBOX.>'], deny: [] },
  })

  // Signed by an account the server was never told about.
  const foreignAkp = createAccount()
  const foreignUkp = createUser()
  const foreignJwt = await encodeUser('FOREIGN', foreignUkp, foreignAkp, {})

  const oJwt = await encodeOperator('TEST', okp, {
    system_account: skp.getPublicKey(),
  })

  const conf = `operator: "${oJwt}"
listen: 4222
jetstream: { store_dir: /tmp/js }
resolver: MEMORY
resolver_preload: {
  ${skp.getPublicKey()}: "${sJwt}"
  ${akp.getPublicKey()}: "${aJwt}"
}
`

  const container = await new GenericContainer('nats:2.10-alpine')
    .withCopyContentToContainer([{ content: conf, target: '/etc/nats.conf' }])
    .withExposedPorts(4222)
    .withCommand(['-c', '/etc/nats.conf', '-DV'])
    .withWaitStrategy(Wait.forLogMessage(/.*Server is ready.*/))
    .withStartupTimeout(60_000)
    .withLogConsumer((stream) => {
      stream.on('data', chunk => process.stdout.write(`[nats] ${chunk.toString()}`))
    })
    .start()

  const port = container.getMappedPort(4222)
  const host = container.getHost()
  const servers = `nats://${host}:${port}`

  ctx = {
    container,
    servers,
    userJwt: uJwt,
    nkeySeed: new TextDecoder().decode(ukp.getSeed()),
    badNkeySeed: new TextDecoder().decode(badUkp.getSeed()),
    creds: new TextDecoder().decode(fmtCreds(uJwt, ukp)),
    foreignCreds: new TextDecoder().decode(fmtCreds(foreignJwt, foreignUkp)),
    bearerJwt,
    issueCreds: async (ttlSec: number) => {
      const jwt = await encodeUser('U', ukp, akp, {
        pub: { allow: ['jwt.>', '_INBOX.>', '$JS.API.>'], deny: [] },
        sub: { allow: ['jwt.>', '_INBOX.>', '$JS.API.>'], deny: [] },
      }, { exp: Math.floor(Date.now() / 1000) + ttlSec })
      return new TextDecoder().decode(fmtCreds(jwt, ukp))
    },
  }
}, 90_000)

afterAll(async () => {
  if (ctx?.container) {
    try { await ctx.container.stop() }
    catch {}
  }
})

describe('buildAuthOptions — JWT+NKey against a JWT-resolver NATS server', () => {
  it('connects successfully with a valid userJwt + matching nkeySeed', async () => {
    const auth = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: ctx.nkeySeed,
      userJwt: ctx.userJwt,
    })

    const nc = await connect({ servers: [ctx.servers], ...auth })
    expect(nc.isClosed()).toBe(false)
    await nc.drain()
  })

  it('round-trips a JetStream message via JWT+NKey auth', async () => {
    const auth = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: ctx.nkeySeed,
      userJwt: ctx.userJwt,
    })

    const nc = await connect({ servers: [ctx.servers], ...auth })
    const js = jetstream(nc)
    const jsm = await jetstreamManager(nc)

    await jsm.streams.add({
      name: 'JWT_TEST',
      subjects: ['jwt.>'],
      storage: 'memory',
    } as any)

    const ack = await js.publish('jwt.test', new TextEncoder().encode('hello'))
    expect(ack.seq).toBeGreaterThanOrEqual(1)

    const info = await jsm.streams.info('JWT_TEST')
    expect(info.state.messages).toBeGreaterThanOrEqual(1)

    await jsm.streams.delete('JWT_TEST')
    await nc.drain()
  })

  it('rejects connection when nkeySeed does not match the userJwt (Authorization Violation)', async () => {
    const auth = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: ctx.badNkeySeed,
      userJwt: ctx.userJwt,
    })

    await expect(
      connect({ servers: [ctx.servers], ...auth, maxReconnectAttempts: 0, reconnect: false }),
    ).rejects.toThrow()
  })

  it('rejects connection with a malformed userJwt (Authorization Violation)', async () => {
    const auth = buildAuthOptions({
      token: '',
      user: '',
      pass: '',
      nkeySeed: ctx.nkeySeed,
      userJwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib2cifQ.bad-signature',
    })

    await expect(
      connect({ servers: [ctx.servers], ...auth, maxReconnectAttempts: 0, reconnect: false }),
    ).rejects.toThrow()
  })
})

describe('buildAuthOptions — .creds (Synadia Cloud style) against a JWT-resolver NATS server', () => {
  const none = { token: '', user: '', pass: '', nkeySeed: '', userJwt: '' }

  it('connects with raw creds file contents', async () => {
    const nc = await connect({ servers: [ctx.servers], ...buildAuthOptions({ ...none, creds: ctx.creds }) })
    expect(nc.isClosed()).toBe(false)
    await nc.drain()
  })

  it('connects with base64-encoded creds (as stored in an env var or secrets manager)', async () => {
    const creds = Buffer.from(ctx.creds).toString('base64')
    const nc = await connect({ servers: [ctx.servers], ...buildAuthOptions({ ...none, creds }) })
    expect(nc.isClosed()).toBe(false)
    await nc.drain()
  })

  it('connects with a creds file and re-reads it on reconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuxt-nats-creds-'))
    const credsFile = join(dir, 'user.creds')
    writeFileSync(credsFile, ctx.foreignCreds)

    // The file holds creds the server rejects, so the first connect fails...
    await expect(
      connect({ servers: [ctx.servers], ...buildAuthOptions({ ...none, credsFile }), maxReconnectAttempts: 0, reconnect: false }),
    ).rejects.toThrow()

    // ...and the same options succeed once the file is rotated, without rebuilding them.
    const auth = buildAuthOptions({ ...none, credsFile })
    writeFileSync(credsFile, ctx.creds)
    const nc = await connect({ servers: [ctx.servers], ...auth })
    expect(nc.isClosed()).toBe(false)
    await nc.drain()
  })

  it('creds take priority over a conflicting userJwt / nkeySeed', async () => {
    const auth = buildAuthOptions({ ...none, creds: ctx.creds, userJwt: 'eyJ.bad.jwt', nkeySeed: ctx.badNkeySeed })
    const nc = await connect({ servers: [ctx.servers], ...auth })
    expect(nc.isClosed()).toBe(false)
    await nc.drain()
  })

  it('connects a bearer-token user with the JWT alone (no seed)', async () => {
    const nc = await connect({ servers: [ctx.servers], ...buildAuthOptions({ ...none, userJwt: ctx.bearerJwt }) })
    expect(nc.isClosed()).toBe(false)
    await nc.drain()
  })
})

describe('CredentialManager — rotating short-lived credentials against a JWT-resolver NATS server', () => {
  // 8s JWTs, refreshed half their lifetime before expiry: several expiries inside one test.
  const TTL = 8
  const refresh = { leadRatio: 0.5, minLeadSec: 2, maxLeadSec: 10, maxBackoffSec: 2 }

  async function roundTrip(nc: Awaited<ReturnType<typeof connect>>, subject: string) {
    const sub = nc.subscribe(subject, { max: 1, callback: (_e, m) => { m.respond(m.data) } })
    const reply = await nc.request(subject, new TextEncoder().encode('ping'), { timeout: 3_000 })
    sub.unsubscribe()
    return new TextDecoder().decode(reply.data)
  }

  it('control: without rotation the server disconnects the user when its JWT expires', async () => {
    const auth = buildAuthOptions({ token: '', user: '', pass: '', nkeySeed: '', userJwt: '', creds: await ctx.issueCreds(3) })
    const nc = await connect({ servers: [ctx.servers], ...auth, maxReconnectAttempts: 0 })
    const statuses: string[] = []
    ;(async () => {
      for await (const s of nc.status()) statuses.push(s.type)
    })()
    await new Promise(r => setTimeout(r, 5_000))
    expect(statuses).toContain('disconnect')
    await nc.close()
  }, 20_000)

  it('keeps the connection usable across several JWT expiries with no restart', async () => {
    const issued: number[] = []
    const manager = new CredentialManager({
      name: 'rotating',
      fetch: async () => {
        issued.push(Date.now())
        return { creds: await ctx.issueCreds(TTL) }
      },
    }, refresh)
    await manager.init()

    const nc = await connect({
      servers: [ctx.servers],
      authenticator: manager.authenticator(),
      ignoreAuthErrorAbort: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 250,
    })
    manager.attach(() => nc.reconnect())

    // 2.5 JWT lifetimes: every original JWT has expired by the end.
    await new Promise(r => setTimeout(r, TTL * 2.5 * 1000))

    expect(issued.length).toBeGreaterThanOrEqual(3)
    expect(nc.isClosed()).toBe(false)
    expect(await roundTrip(nc, 'jwt.rotate')).toBe('ping')
    expect(manager.snapshot().status).toBe('ok')

    await manager.dispose()
    await nc.close()
  }, 40_000)
})
