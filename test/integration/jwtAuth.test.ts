import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { connect } from '@nats-io/transport-node'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { createOperator, createAccount, createUser, encodeOperator, encodeAccount, encodeUser, fmtCreds } from '@nats-io/jwt'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { buildAuthOptions } from '../../src/runtime/server/utils/buildConnectionOptions'

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
