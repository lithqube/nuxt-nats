import { AgentService } from '@synadia-ai/agent-service'
import type { AgentServiceExtraEndpoint, PromptHandler } from '@synadia-ai/agent-service'
import { getNatsConnection } from '../plugins/_connection'

export interface NatsAgentOptions {
  /** metadata.agent — canonical harness identifier. Lowercase a-z 0-9 - _, never leading `$`. */
  agent: string
  /** metadata.owner — operator / tenant namespace. */
  owner: string
  /** Instance name — the 5th subject token (e.g. a session or node id). */
  name: string
  /**
   * Prompt handler: `(envelope, response) => …`. Stream chunks back with
   * `response.send(...)`; ask the caller a mid-stream question with
   * `response.ask(prompt, { timeoutMs })`. The SDK emits the mandatory leading
   * `ack` chunk and the zero-byte terminator for you.
   */
  onPrompt: PromptHandler
  /** Optional override for the subject's 3rd token (e.g. `cc` for `claude-code`). Defaults to `agent`. */
  subjectToken?: string
  /** Human-readable service description surfaced by `nats micro info`. */
  description?: string
  /** Harness semver advertised as `service.version`. */
  version?: string
  /** Heartbeat cadence in seconds (§8.2). Default: 30. */
  heartbeatIntervalS?: number
  /** Whether the prompt endpoint accepts attachments (§2.1). Default: true. */
  attachmentsOk?: boolean
  /**
   * `max_payload` override (§2.1). Omit to advertise the broker-negotiated
   * `nc.info.max_payload` (the SDK clamps an over-large override down to the
   * server limit).
   */
  maxPayload?: string
  /** Extra metadata merged into the service metadata (forward-compat). */
  extraMetadata?: Record<string, string>
  /**
   * Custom endpoints registered alongside the protocol-required `prompt` /
   * `status` (e.g. a controller's `spawn` / `stop` / `list`). Subjects are
   * advertised verbatim — assemble the full `agents.*` subject yourself.
   */
  extraEndpoints?: AgentServiceExtraEndpoint[]
}

export interface NatsAgentHandle {
  /** Stop heartbeats + endpoints and deregister the micro service. Idempotent. */
  stop: () => Promise<void>
  /** Current lifecycle state, for health reporting. */
  status: () => 'starting' | 'running' | 'stopped' | 'error'
  /** Identity tuple, for health reporting. */
  identity: { agent: string, owner: string, name: string }
}

interface ActiveAgent extends NatsAgentHandle {
  _service?: AgentService
}

const _activeAgents: ActiveAgent[] = []

/**
 * Register and serve a Synadia Agent Protocol agent over the module's NATS
 * connection, making it discoverable (`$SRV.PING.agents`) and promptable by
 * any protocol-compliant caller.
 *
 * Like {@link defineNatsConsumer}, this only runs when NUXT_NATS_WORKERS=true —
 * an agent is a long-lived micro service that beacons heartbeats continuously,
 * which is wrong for a serverless/edge deployment.
 *
 * Resilient to call order: it waits for the NATS connection to be established
 * before registering, so it can be called from any server plugin without
 * depending on plugin ordering. The service is stopped automatically on
 * shutdown (via {@link stopAllAgents}, called before the connection drains).
 *
 * @example
 *   defineNatsAgent({
 *     agent: 'nuxt-assistant', owner: 'acme', name: 'web-1',
 *     async onPrompt(envelope, response) {
 *       for await (const token of llm.stream(envelope.prompt)) {
 *         await response.send(token)
 *       }
 *     },
 *   })
 */
export function defineNatsAgent(opts: NatsAgentOptions): NatsAgentHandle {
  if (process.env.NUXT_NATS_WORKERS !== 'true') {
    console.warn(`[nuxt-nats] Agent "${opts.agent}/${opts.owner}/${opts.name}" skipped — set NUXT_NATS_WORKERS=true to enable workers`)
    return {
      stop: async () => {},
      status: () => 'stopped',
      identity: { agent: opts.agent, owner: opts.owner, name: opts.name },
    }
  }

  let stopped = false
  let state: 'starting' | 'running' | 'stopped' | 'error' = 'starting'

  const handle: ActiveAgent = {
    identity: { agent: opts.agent, owner: opts.owner, name: opts.name },
    status: () => state,
    stop: async () => {
      stopped = true
      state = 'stopped'
      try {
        await handle._service?.stop()
      }
      catch (err) {
        console.error(`[nuxt-nats] Error stopping agent "${opts.agent}/${opts.owner}/${opts.name}":`, err)
      }
      handle._service = undefined
    },
  }
  _activeAgents.push(handle)

  // Start async — wait for the connection, then register the micro service.
  ;(async () => {
    while (!stopped && !getNatsConnection()) {
      await new Promise(r => setTimeout(r, 250))
    }
    if (stopped) return

    const nc = getNatsConnection()!
    while (!stopped) {
      try {
        const service = new AgentService({
          nc,
          agent: opts.agent,
          owner: opts.owner,
          name: opts.name,
          ...(opts.subjectToken !== undefined ? { subjectToken: opts.subjectToken } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.heartbeatIntervalS !== undefined ? { heartbeatIntervalS: opts.heartbeatIntervalS } : {}),
          ...(opts.attachmentsOk !== undefined ? { attachmentsOk: opts.attachmentsOk } : {}),
          ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}),
          ...(opts.extraMetadata !== undefined ? { extraMetadata: opts.extraMetadata } : {}),
          ...(opts.extraEndpoints !== undefined ? { extraEndpoints: opts.extraEndpoints } : {}),
        })
        service.onPrompt(opts.onPrompt)
        await service.start()

        if (stopped) {
          // stop() raced ahead of start(); tear the service back down.
          await service.stop()
          return
        }
        handle._service = service
        state = 'running'
        console.log(`[nuxt-nats] Agent up: agents.prompt.${opts.subjectToken ?? opts.agent}.${opts.owner}.${opts.name}`)
        return
      }
      catch (err) {
        state = 'error'
        if (stopped) return
        console.error(`[nuxt-nats] Agent "${opts.agent}/${opts.owner}/${opts.name}" failed to start, retrying in 5s:`, err)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  })()

  return handle
}

/**
 * Stop all running agents (heartbeats + endpoints). Called automatically on
 * shutdown — before stopAllConsumers() and nc.drain() — so in-flight prompt
 * streams and the heartbeat loop are torn down before the connection closes.
 */
export async function stopAllAgents(): Promise<void> {
  const agents = [..._activeAgents]
  _activeAgents.length = 0
  await Promise.all(agents.map(a => a.stop()))
}

/** Snapshot of registered agents, for the health endpoint. */
export function getAgentStatuses(): Array<{ agent: string, owner: string, name: string, status: string }> {
  return _activeAgents.map(a => ({ ...a.identity, status: a.status() }))
}
