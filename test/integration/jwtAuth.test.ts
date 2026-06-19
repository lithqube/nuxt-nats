import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { connect } from '@nats-io/transport-node'
import { jetstream, jetstreamManager } from '@nats-io/jetstream'
import { createOperator, createAccount, createUser, encodeOperator, encodeAccount, encodeUser } from '@nats-io/jwt'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { buildAuthOptions } from '../../src/runtime/server/utils/buildConnectionOptions'

interface JwtAuthTestContext {
  container: StartedTestContainer
  servers: string
  userJwt: string
  nkeySeed: string
  badNkeySeed: string
}

let ctx: JwtAuthTestContext

beforeAll(async () => {
  const okp = createOperator()
  const skp = createAccount()
  const ukp = createUser()
  const badUkp = createUser()

  const sJwt = await encodeAccount('SYS', skp, {
    name: 'SYS',
    limits: { conn: -1, subs: -1, data: -1, payload: -1, imports: -1, exports: -1, wildcards: true, leaf: -1 },
    jetstream: { max_mem: 0, max_store: 0, max_streams: -1, max_consumers: -1 },
  } as any, { signer: okp })

  const uJwt = await encodeUser('U', ukp, skp, {
    name: 'U',
    pub: { allow: ['jwt.>', '_INBOX.>', '$JS.API.>'], deny: [] },
    sub: { allow: ['jwt.>', '_INBOX.>', '$JS.API.>'], deny: [] },
  })

  const oJwt = await encodeOperator('TEST', okp, {
    name: 'TEST',
    system_account: skp.getPublicKey(),
  } as any)

  const conf = `operator: "${oJwt}"
listen: 4222
jetstream: { store_dir: /tmp/js }
resolver: MEMORY
resolver_preload: {
  ${skp.getPublicKey()}: "${sJwt}"
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
