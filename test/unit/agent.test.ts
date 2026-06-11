import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  defineNatsAgent,
  stopAllAgents,
  getAgentStatuses,
} from '../../src/runtime/server/utils/defineNatsAgent'
import { useAgents, closeAgents } from '../../src/runtime/server/utils/useAgents'

// Hoisted so the vi.mock factories (which vitest hoists above the imports) can
// safely reference these spies and the mutable connection state.
const h = vi.hoisted(() => ({
  startSpy: vi.fn().mockResolvedValue(undefined),
  stopSpy: vi.fn().mockResolvedValue(undefined),
  onPromptSpy: vi.fn(),
  ctorArgs: [] as unknown[],
  agentsCloseSpy: vi.fn().mockResolvedValue(undefined),
  agentsCtorArgs: [] as unknown[],
  conn: undefined as unknown,
}))

// --- Mock the Synadia host SDK: capture constructor args + spy lifecycle ---
vi.mock('@synadia-ai/agent-service', () => ({
  AgentService: class {
    constructor(opts: unknown) {
      h.ctorArgs.push(opts)
    }

    onPrompt = h.onPromptSpy
    start = h.startSpy
    stop = h.stopSpy
  },
}))

// --- Mock the Synadia caller SDK ---
vi.mock('@synadia-ai/agents', () => ({
  Agents: class {
    constructor(opts: unknown) {
      h.agentsCtorArgs.push(opts)
    }

    close = h.agentsCloseSpy
  },
}))

// --- Mock the connection singleton (Nitro-free) ---
vi.mock('../../src/runtime/server/plugins/_connection', () => ({
  getNatsConnection: () => h.conn,
}))

const { startSpy, stopSpy, onPromptSpy, ctorArgs, agentsCloseSpy, agentsCtorArgs } = h

const fakeNc = { info: { max_payload: 1_000_000 } }
const flush = () => new Promise(r => setTimeout(r, 0))

describe('defineNatsAgent', () => {
  beforeEach(() => {
    h.conn = undefined
    ctorArgs.length = 0
  })

  afterEach(async () => {
    await stopAllAgents()
    delete process.env.NUXT_NATS_WORKERS
    vi.restoreAllMocks()
    startSpy.mockClear()
    stopSpy.mockClear()
    onPromptSpy.mockClear()
  })

  it('is a no-op without NUXT_NATS_WORKERS=true (never constructs a service)', async () => {
    h.conn = fakeNc
    const handle = defineNatsAgent({ agent: 'echo', owner: 'demo', name: 'main', onPrompt: vi.fn() })
    await flush()
    expect(handle.status()).toBe('stopped')
    expect(ctorArgs).toHaveLength(0)
    expect(getAgentStatuses()).toHaveLength(0)
  })

  it('registers and starts the service when workers are enabled', async () => {
    process.env.NUXT_NATS_WORKERS = 'true'
    h.conn = fakeNc
    const onPrompt = vi.fn()
    const handle = defineNatsAgent({ agent: 'echo', owner: 'demo', name: 'main', onPrompt })
    await flush()

    expect(ctorArgs).toHaveLength(1)
    expect(ctorArgs[0]).toMatchObject({ agent: 'echo', owner: 'demo', name: 'main', nc: fakeNc })
    expect(onPromptSpy).toHaveBeenCalledWith(onPrompt)
    expect(startSpy).toHaveBeenCalledOnce()
    expect(handle.status()).toBe('running')

    const statuses = getAgentStatuses()
    expect(statuses).toEqual([{ agent: 'echo', owner: 'demo', name: 'main', status: 'running' }])
  })

  it('waits for the NATS connection before registering', async () => {
    process.env.NUXT_NATS_WORKERS = 'true'
    h.conn = undefined // not connected yet
    defineNatsAgent({ agent: 'echo', owner: 'demo', name: 'main', onPrompt: vi.fn() })
    await flush()
    expect(ctorArgs).toHaveLength(0) // still waiting

    h.conn = fakeNc // connection comes up
    await new Promise(r => setTimeout(r, 300)) // poll interval is 250ms
    expect(startSpy).toHaveBeenCalledOnce()
  })

  it('only forwards options that were provided (no undefined keys leak)', async () => {
    process.env.NUXT_NATS_WORKERS = 'true'
    h.conn = fakeNc
    defineNatsAgent({ agent: 'cc', owner: 'demo', name: 'main', subjectToken: 'cc', heartbeatIntervalS: 5, onPrompt: vi.fn() })
    await flush()
    const opts = ctorArgs[0] as Record<string, unknown>
    expect(opts.subjectToken).toBe('cc')
    expect(opts.heartbeatIntervalS).toBe(5)
    expect('maxPayload' in opts).toBe(false)
    expect('extraEndpoints' in opts).toBe(false)
  })

  it('stop() tears down the service and removes itself from the registry', async () => {
    process.env.NUXT_NATS_WORKERS = 'true'
    h.conn = fakeNc
    const handle = defineNatsAgent({ agent: 'echo', owner: 'demo', name: 'main', onPrompt: vi.fn() })
    await flush()
    expect(getAgentStatuses()).toHaveLength(1)

    await handle.stop()
    expect(stopSpy).toHaveBeenCalledOnce()
    expect(handle.status()).toBe('stopped')
    // Individual stop() deregisters so health no longer reports the stopped agent.
    expect(getAgentStatuses()).toHaveLength(0)
  })

  it('stopAllAgents clears the registry even with multiple agents', async () => {
    process.env.NUXT_NATS_WORKERS = 'true'
    h.conn = fakeNc
    defineNatsAgent({ agent: 'echo', owner: 'demo', name: 'a', onPrompt: vi.fn() })
    defineNatsAgent({ agent: 'echo', owner: 'demo', name: 'b', onPrompt: vi.fn() })
    await flush()
    expect(getAgentStatuses()).toHaveLength(2)

    await stopAllAgents()
    expect(getAgentStatuses()).toHaveLength(0)
  })
})

describe('useAgents / closeAgents', () => {
  beforeEach(() => {
    h.conn = undefined
    agentsCtorArgs.length = 0
  })

  afterEach(async () => {
    await closeAgents()
    vi.restoreAllMocks()
    agentsCloseSpy.mockClear()
  })

  it('throws when the NATS connection is not available', () => {
    h.conn = undefined
    expect(() => useAgents()).toThrow(/NATS connection is not available/)
  })

  it('constructs once and caches the client across calls', () => {
    h.conn = fakeNc
    const a = useAgents()
    const b = useAgents()
    expect(a).toBe(b)
    expect(agentsCtorArgs).toHaveLength(1)
    expect(agentsCtorArgs[0]).toMatchObject({ nc: fakeNc })
  })

  it('closeAgents() closes the client and drops the cache', async () => {
    h.conn = fakeNc
    useAgents()
    await closeAgents()
    expect(agentsCloseSpy).toHaveBeenCalledOnce()
    // After close, a new call rebuilds.
    useAgents()
    expect(agentsCtorArgs).toHaveLength(2)
  })
})
