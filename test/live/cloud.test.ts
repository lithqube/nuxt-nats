import { readFileSync } from 'node:fs'
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { connect, wsconnect } from '@nats-io/transport-node'
import type { NatsConnection } from '@nats-io/nats-core'
import { jetstreamManager } from '@nats-io/jetstream'
import { buildAuthOptions } from '../../src/runtime/server/utils/buildConnectionOptions'
import { parseCreds } from '../../src/runtime/server/utils/parseCreds'
import { synadiaServers } from '../../src/synadia'
import type { SynadiaRegion } from '../../src/synadia'
import { resolveSynadiaToken } from '../../scripts/synadia-token.mjs'
import { createSynadiaClient } from '../../src/runtime/synadia/client'
import { runRotate } from '../../src/runtime/cli/rotate'

// Opt-in, with either credential source:
//   SYNADIA_LIVE=1 SYNADIA_NATS_USER_ID=<id> npm run test:live
//     fetches fresh creds for that NATS user from the Control Plane API with your personal
//     access token and keeps them in memory. The token comes from SYNADIA_CLOUD_TOKEN,
//     ~/.config/synadia/token or the macOS Keychain (scripts/synadia-token.mjs). Find the
//     user id with `node scripts/synadia-creds.mjs list`.
//   SYNADIA_LIVE=1 SYNADIA_CREDS_FILE=/path/to/user.creds npm run test:live
// Optional: SYNADIA_REGION (default global), SYNADIA_SUBJECT_PREFIX (default nuxtnats.live),
// SYNADIA_STREAMS=1 to also create and delete an R1 stream (uses one of your plan's streams).
// The user needs pub/sub on "<prefix>.>" and "_INBOX.>", plus $JS.API.> for the stream test.
const env = process.env
const pat = env.SYNADIA_NATS_USER_ID ? resolveSynadiaToken(env)?.token : undefined
const viaToken = !!pat
const enabled = env.SYNADIA_LIVE === '1' && (viaToken || !!env.SYNADIA_CREDS_FILE)
const apiUrl = (env.SYNADIA_API_URL ?? 'https://cloud.synadia.com/api').replace(/\/$/, '')
const prefix = process.env.SYNADIA_SUBJECT_PREFIX ?? 'nuxtnats.live'
const region = (process.env.SYNADIA_REGION ?? 'global') as SynadiaRegion

const none = { token: '', user: '', pass: '', nkeySeed: '', userJwt: '' }
const open: NatsConnection[] = []

afterEach(async () => {
  // Free plans allow few connections: always release them.
  await Promise.allSettled(open.splice(0).map(nc => nc.close()))
})

describe.skipIf(!enabled)('Synadia Cloud (live)', () => {
  const { servers, wsServers } = synadiaServers(region)
  // Creds contents (token path) or undefined (file path).
  let creds: string | undefined
  const auth = () => creds
    ? buildAuthOptions({ ...none, creds })
    : buildAuthOptions({ ...none, credsFile: env.SYNADIA_CREDS_FILE })

  // Resolve and check the creds before connecting: over TLS the client swallows an
  // authenticator error and the server reports only an "Authentication Timeout" after ~15s.
  beforeAll(async () => {
    if (viaToken) {
      const res = await fetch(`${apiUrl}/core/beta/nats-users/${encodeURIComponent(env.SYNADIA_NATS_USER_ID!)}/creds`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, Accept: 'text/plain' },
      })
      // Status only: the body is not needed to diagnose this and the token is never echoed.
      if (!res.ok) throw new Error(`Control Plane creds request for SYNADIA_NATS_USER_ID failed: HTTP ${res.status}`)
      creds = await res.text()
      parseCreds(creds)
      return
    }
    const path = env.SYNADIA_CREDS_FILE!
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    }
    catch (err) {
      throw new Error(`SYNADIA_CREDS_FILE "${path}" cannot be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, { cause: err })
    }
    parseCreds(text) // throws a clear error for a file that is not a .creds file
  })

  it('connects over TLS with creds and round-trips a request', async () => {
    const nc = await connect({ servers, name: 'nuxt-nats-live-test', ...auth() })
    open.push(nc)
    const subject = `${prefix}.echo`
    const sub = nc.subscribe(subject, { max: 1, callback: (_err, msg) => { msg.respond(msg.data) } })
    const reply = await nc.request(subject, new TextEncoder().encode('ping'), { timeout: 5_000 })
    expect(new TextDecoder().decode(reply.data)).toBe('ping')
    sub.unsubscribe()
  })

  it('connects over WebSocket', async () => {
    const nc = await wsconnect({ servers: wsServers, name: 'nuxt-nats-live-test-ws', ...auth() })
    open.push(nc)
    expect(await nc.rtt()).toBeGreaterThan(0)
  })

  it.skipIf(process.env.SYNADIA_STREAMS !== '1')('creates and deletes an R1 stream', async () => {
    const nc = await connect({ servers, name: 'nuxt-nats-live-test-js', ...auth() })
    open.push(nc)
    const jsm = await jetstreamManager(nc)
    const name = `NUXTNATS_LIVE_${Date.now()}`
    await jsm.streams.add({ name, subjects: [`${prefix}.js.>`], num_replicas: 1, max_bytes: 1024 * 1024 } as never)
    try {
      expect((await jsm.streams.info(name)).config.name).toBe(name)
    }
    finally {
      await jsm.streams.delete(name)
    }
  })
})

// Control Plane client and rotator against the real API. Read-only apart from issuing creds
// (an issuance) for SYNADIA_NATS_USER_ID; the rotator runs with --dry-run.
describe.skipIf(!(env.SYNADIA_LIVE === '1' && viaToken))('Synadia Control Plane (live)', () => {
  const client = () => createSynadiaClient({ token: pat!, apiUrl })

  it('reads the user, its account and its issuances', async () => {
    const c = client()
    const user = await c.natsUsers.get(env.SYNADIA_NATS_USER_ID!)
    expect(user.id).toBe(env.SYNADIA_NATS_USER_ID)
    expect(user.user_public_key).toMatch(/^U/)
    const account = await c.getAccount(user.account.id)
    expect(account.id).toBe(user.account.id)
    expect((await c.natsUsers.list(account.id)).some(u => u.id === user.id)).toBe(true)
    expect(Array.isArray(await c.natsUsers.listIssuances(user.id))).toBe(true)
    expect((await c.listTeams()).length).toBeGreaterThan(0)
  })

  it('rotator --dry-run --verify issues creds that connect to Synadia Cloud', async () => {
    const out: string[] = []
    const { code, result } = await runRotate(
      ['--user-id', env.SYNADIA_NATS_USER_ID!, '--store', 'module:test/fixtures/credentials/empty-store.mjs', '--force', '--dry-run', '--verify'],
      { env: { SYNADIA_CLOUD_TOKEN: pat!, SYNADIA_API_URL: apiUrl }, out: l => out.push(l), err: () => {} },
    )
    expect(code).toBe(0)
    expect(result.action).toBe('dry-run')
    expect(out.join('')).not.toContain(pat!)
  })
})
