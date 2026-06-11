# Agent Fabric Architecture

How the pieces fit together, so you can decide what to build before writing code.

## Two sides: host SDK and caller SDK

The SDK is split by role. Most projects use exactly one side; orchestrators that are themselves agents use both.

| Side             | You're building…                                  | TS package                 | Python package                 |
|------------------|---------------------------------------------------|----------------------------|--------------------------------|
| **Host / agent** | an agent that registers and answers prompts       | `@synadia-ai/agent-service`| `synadia-ai-agent-service`     |
| **Caller / client** | a meta-agent/app that discovers and prompts agents | `@synadia-ai/agents`     | `synadia-ai-agents`            |

- **Host SDK** embeds an `AgentService` in your harness: you register as service name `agents`, supply an `onPrompt` handler, and the SDK handles micro registration, the leading `ack` chunk, the queue group, heartbeats, per-request keep-alive, and the stream terminator. Three extension seams beyond the basic handler:
  - **`extraEndpoints`** — declarative custom endpoints (`spawn`/`stop`/`list` on a controller) registered alongside `prompt`/`status`, with collision validation at `start()`. The `.service` getter is the escape hatch for runtime-dynamic registration.
  - **`PromptResponse.ask` / `PromptStream.ask`** — round-trip a §7 mid-stream query (human-in-the-loop) without leaving the handler.
  - **Wire helpers** (`encodeChunk`, `splitResponseText`, `buildHeartbeatPayload`, `encodeHeartbeatPayload`, `DEFAULT_*`) — drive the wire directly when your producer is event-driven and doesn't fit the closed `onPrompt` shape. Several shipped channels (`openclaw`, `pi`, `claude-code`) use these instead of `AgentService`.
- **Caller SDK** gives you an `Agents` client: `discover()` the fleet, bind to an agent, `prompt()` it, and iterate typed chunks. It also tracks liveness from heartbeats (`liveness`/`onHeartbeat`/`ping`), pre-flight-validates payloads against the smaller of the two `max_payload`s (raising `PayloadTooLargeError` / `AttachmentsNotSupportedError` before any wire traffic), and offers `withAgentReconnectDefaults` for runtimes that must outlive broker blips. Python adds `prompt(max_wait_s=…)` with `StreamStalledError` / `StreamMaxWaitExceededError` for the §6.6 inactivity timeout.

Mental model: **an agent is a function from a prompt to a streamed reply.** The SDK is the plumbing around that function; only the body differs between an echo agent, an LLM agent, and a full coding harness.

## Meta-agent vs worker

The protocol is shaped for *many processes, many agents, none known to the caller in advance* — the opposite of "one process, one known endpoint."

- A **worker agent** does the work (runs an LLM, a tool loop, a coding harness). It hosts.
- A **meta-agent** coordinates other agents: discovers them, fans a prompt out, merges responses, tracks who's alive. It calls — and, if it also answers prompts itself, it hosts too.

This is **A2A-style coordination**. It is *not* MCP: MCP gives one agent its tools/context; this gives a bus full of agents a way to find and talk to each other. The two compose — an MCP-equipped agent can be exposed on the fabric.

## Pre-built plugins (zero-code hosting)

The `agents/` directory of the SDK repo ships channels that expose existing harnesses on the fabric with little or no code. Token in parens:

| Channel | Token | `attachments_ok` | Notes |
|---------|-------|------------------|-------|
| `claude-code` | `cc` | true | Ships as a **Claude Code plugin** (`/plugin install`). Beats every 5 s. Two permission modes: `terminal` (prompt locally) or `query` (relay as a §7 `query` chunk over NATS). |
| `pi` | `pi` | true | One agent instance per running PI CLI session. |
| `openclaw` | `oc` | true | One agent per account; also emits outbound on `<subject>.outbound`. |
| `hermes` | `hermes` | true | One identity multiplexes conversations via the envelope's optional `session` field. |
| `opencode` | `opencode` | false | Bun plugin under `.opencode/plugins/`; built on `AgentService`. |
| `deerflow` | `df` | true | Python wrapper on `synadia-ai-agent-service`; uploads attachments to the Gateway. |
| `flue` | `flue` | false | Sidecar on `@synadia-ai/agent-service`. |
| `open-agent` | `open-agent` | false | First channel built directly on `AgentService`; ships a `LocalSandbox`. |

If the user just wants to put Claude Code or another supported harness on the bus, point them at the matching channel rather than writing a host from scratch. For *building* a fresh agent from scratch with the host SDK, the `examples/dspy/` (DSPy ReAct) agent is the reference. Most attachment-accepting channels decode to a per-session staging dir and prepend absolute paths to the prompt text.

## Load-balancing & scaling

Because the `prompt` endpoint registers on the NATS queue group `agents`, running N instances of the same agent (same `agent`/`owner`, different `name`/`instance_id`) automatically load-balances prompts across them — no router, no config. This is plain NATS queue-group semantics; scale out by starting more instances.

To address a *specific* instance rather than any-of-N, use the instance-scoped discovery subject `$SRV.INFO.agents.{instance_id}` and the endpoint subject it returns.

## Identity & multi-tenancy

Identity is the tuple `agent` / `owner` / `name` (+ `session`). It composes both the subject namespace and the discovery metadata, so choose stable, lowercase tokens early.

Multi-tenancy and isolation come from **NATS accounts**, inherited from the bus — not from application code. Put different tenants/owners in different accounts and the fabric enforces separation, including which agents can even see each other in discovery. For how to configure accounts, TLS, and authn/authz on the servers, defer to the `jetstream-deployment` skill.

Every prompt and response is a NATS message, so the fabric gives you a natural **audit trail** — tap or persist the `agents.>` subjects (a good JetStream capture point).

## Where JetStream and KV fit

The transport is the NATS **Services API (micro)** — stateless request/reply + queue groups. Core JetStream is **not** required for v0.3.

JetStream and KV are the **roadmap layer for durable state and session handoff**: persistent agent memory, resumable sessions, handing a task from one agent to another. They're "available for future durable state," not part of the stateless transport contract. When agents need to *remember* or *hand off*, see `patterns/durable-state.md`, and design the underlying streams/buckets with the `jetstream-architecture` skill.

## What ships today vs. what's coming

- **Today:** connectivity, identity, discovery, streaming, heartbeats, audit trail; TS + Python SDKs (caller + host, lockstep); `extraEndpoints` controller pattern; mid-stream `ask`; `ReferenceAgent` for interop testing; resilient reconnect + local validation on the caller; protocol v0.3.
- **Coming:** durable state/handoff (JetStream + KV), the `attachments` upload endpoint (verb reserved, wire deferred), richer agent-to-agent capability negotiation, zero-trust security (class/instance identity, dynamic permissions). **Go SDK is planned.**

Treat anything beyond the v0.3 transport as subject to change, and pin package versions.
