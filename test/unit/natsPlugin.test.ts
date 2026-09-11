import { describe, it, expect, vi, afterEach } from 'vitest'

// nats.ts imports nitropack/runtime, which only resolves inside a Nitro build, and its plugin
// body connects over the network. Stub both so the boot sequence can run here.
const state = vi.hoisted(() => ({ jsSeenWhileProvisioning: [] as unknown[] }))

vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (fn: unknown) => fn,
  useRuntimeConfig: () => ({
    nats: {
      servers: ['nats://test:4222'],
      streams: [{ name: 'ORDERS', subjects: ['orders.>'], provision: 'startup' }],
    },
  }),
}))

vi.mock('@nats-io/transport-node', () => ({
  // status() is drained in the background; an empty iterator ends at once.
  connect: vi.fn(async () => ({ status: async function* () {} })),
  wsconnect: vi.fn(),
}))

vi.mock('@nats-io/jetstream', async importOriginal => ({
  ...await importOriginal<typeof import('@nats-io/jetstream')>(),
  jetstream: vi.fn(() => ({ client: 'js' })),
  jetstreamManager: vi.fn(async () => ({ client: 'jsm' })),
}))

vi.mock('../../src/runtime/server/utils/provisionStreams', () => ({
  provisionStreams: vi.fn(async () => {
    // What a consumer polling getJetStream() would see while streams are still being created.
    const { getJetStream } = await import('../../src/runtime/server/plugins/_connection')
    state.jsSeenWhileProvisioning.push(getJetStream())
  }),
}))

const { default: natsPlugin } = await import('../../src/runtime/server/plugins/nats')
const { getJetStream, getJetStreamManager } = await import('../../src/runtime/server/plugins/_connection')
const { provisionStreams } = await import('../../src/runtime/server/utils/provisionStreams')

/**
 * Consumers registered at plugin time wait for getJetStream() before their first pass, since
 * Nitro does not await async plugins. If the client were published before streams are
 * provisioned, a consumer with provision: 'startup' could look up its durable on a stream that
 * does not exist yet and log a spurious loop error on first boot.
 */
describe('connection plugin boot order', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('publishes the JetStream client and manager only after declared streams are provisioned', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Keep the plugin from installing real SIGTERM/SIGINT handlers in the test process.
    vi.spyOn(process, 'once').mockImplementation(() => process)

    await (natsPlugin as unknown as (app: unknown) => Promise<void>)({ hooks: { hook: vi.fn() } })

    expect(provisionStreams).toHaveBeenCalledOnce()
    expect(state.jsSeenWhileProvisioning).toEqual([undefined])
    expect(getJetStream()).toEqual({ client: 'js' })
    expect(getJetStreamManager()).toEqual({ client: 'jsm' })
  })
})
