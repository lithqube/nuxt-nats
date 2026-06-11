---
name: nats-agent-fabric
description: Use this skill whenever users are building AI agents that communicate, register, or coordinate over NATS using the Synadia Agent Protocol or the Synadia Agents SDK — including exposing an agent as a discoverable NATS service, building a meta-agent/orchestrator that discovers and prompts other agents, fanning a prompt out to a fleet of agents and merging replies, streaming agent responses over NATS, human-in-the-loop mid-stream queries, agent heartbeats/liveness, or making a Go/other-language agent protocol-compliant. Triggers on the npm packages @synadia-ai/agents and @synadia-ai/agent-service, the PyPI packages synadia-ai-agents and synadia-ai-agent-service, the `agents.*` subject namespace, or phrases like "agent fabric", "agent discovery over NATS", "orchestrate a fleet of agents", "A2A on NATS", or "register my agent as a NATS service". Use this even when the user doesn't name Synadia — if they want heterogeneous AI agents to find and talk to each other over NATS, this skill applies. Do NOT use for plain JetStream stream/consumer design (use jetstream-architecture), server/cluster deployment (use jetstream-deployment), or troubleshooting a running cluster (use jetstream-operations).
---

# NATS Agent Fabric (Synadia Agent Protocol)

Build AI agents that register on a NATS bus, get discovered by callers, and stream replies — using the **Synadia Agent Protocol for NATS** and the **Synadia Agents SDK**.

The core idea: most agent libraries assume one process and one known endpoint. This protocol is built for the opposite shape — **many agents, across many harnesses/runtimes/clouds, none known to the caller in advance**. An agent is just a function from a prompt to a streamed reply (`onPrompt`); only the body differs. Agents register as ordinary [NATS micro-services](https://docs.nats.io/using-nats/developer/services), so they inherit NATS accounts (multi-tenancy/isolation), cloud-to-edge connectivity, and a message-level audit trail "for free."

This is **agent-to-agent coordination, not MCP** — MCP standardizes tools/context for one agent; this standardizes discovery + transport across many agents on a shared bus. It is LLM-agnostic: it wraps *harnesses* (Claude Code, a DSPy ReAct loop, your own LLM service), not models.

## Maturity note (read before quoting versions)

The protocol spec is **v0.3** and the 0.x line is explicitly unstable. Package versions as of mid-2026:

| Role | TypeScript (npm) | Python (PyPI) |
|------|------------------|---------------|
| **Caller** (discover + prompt) | `@synadia-ai/agents` **0.5.2** | `synadia-ai-agents` **0.7.x** |
| **Host** (serve an agent) | `@synadia-ai/agent-service` **0.5.2** | `synadia-ai-agent-service` **0.4.1** |

The two packages on each side **release in lockstep** — install both when you write a harness, just the caller when you only orchestrate. **Go SDK is planned, not released** — for Go today, implement the wire protocol directly over `nats.go` micro (see `examples/protocol-go.md`).

The SDKs live in the **`synadia-ai/synadia-agents`** monorepo, now laid out as: `client-sdk/{typescript,python}` (caller), `agent-sdk/{typescript,python}` (host), `agents/` (ready-to-run harness channels — see architecture.md), and `examples/` (a numbered "agent ladder" `01-echo` → `05-tools`, plus a from-scratch `dspy/` agent). The wire spec is its own repo: **`synadia-ai/synadia-agent-sdk-docs`** (`core-protocol.md`).

> The protocol was renamed **"Synadia Agent Protocol for NATS"** (was "NATS Agent Protocol") in the 0.5.2 / 0.4.1 cut — same wire shape, same `protocol_version: "0.3"`. Prefer the new name.

Because SDK APIs may drift inside 0.x, teach the **protocol** (stable) and treat exact constructor/method names as current-but-verify. When generating code, tell the user to confirm the installed package version. The wire protocol is the durable contract that all SDKs and hand-rolled agents must honor.

## When to defer to the JetStream skills

This skill is built on the NATS **Services API (micro)**, *not* core JetStream — discovery, registration, and request/reply all use `$SRV.*` + queue groups. JetStream and KV enter the picture only for **durable agent state and session handoff** (roadmap / optional), covered in `patterns/durable-state.md`.

- Designing the underlying streams/KV buckets that back durable agent memory → also read `jetstream-architecture`.
- Deploying the NATS servers/accounts your agents connect to → `jetstream-deployment`.
- Monitoring, troubleshooting, or tuning the running fabric → `jetstream-operations`.

## Reference Files

Read these as needed — don't load all of them upfront:

- `concepts/protocol.md` — the wire protocol: subject hierarchy, the four verbs, service registration rules, request envelope, response chunk types, stream termination, heartbeats, discovery, errors, versioning. Read this before writing any agent or caller, in any language — it's the contract.
- `concepts/architecture.md` — caller (client) SDK vs host (agent) SDK, meta-agent vs worker shape, queue-group load-balancing, identity (`agent`/`owner`/`name`/`session`), and where JetStream/KV fit. Read when deciding what to build.
- `patterns/meta-agent.md` — discover → fan-out → merge, liveness tracking without polling, human-in-the-loop mid-stream queries, and the **controller pattern** (custom `spawn`/`stop`/`list` endpoints via `extraEndpoints`). Read when building an orchestrator.
- `patterns/durable-state.md` — using JetStream + KV for agent memory and session handoff. Read when agents need to remember or hand off work.
- `patterns/testing.md` — `ReferenceAgent` (TS `/testing` subpath) and the Python reference agent as spec-compliant counterparties for integration/interop tests, plus the wire-helper escape hatch (`encodeChunk` / `splitResponseText` / `buildHeartbeatPayload`) for event-driven harnesses that don't fit the closed `onPrompt` shape. Read when writing tests or a non-handler-shaped host.
- `examples/typescript.md` — caller + host with `@synadia-ai/agents` / `@synadia-ai/agent-service`. Read for TS/Node/Bun code.
- `examples/python.md` — caller + host with `synadia-ai-agents` / `synadia-ai-agent-service`. Read for Python code.
- `examples/protocol-go.md` — a protocol-compliant agent in Go over `nats.go` micro (no SDK yet). Read for Go, or any language without an SDK.

## Workflow

Step 1: Figure out which side they're building. **Host an agent** (make my agent discoverable/promptable)? **Call agents** (orchestrate/meta-agent)? Or **both**? See `concepts/architecture.md`.

Step 2: Pick the language path. TS and Python have SDKs; Go and everything else implement the protocol directly. If they have no SDK for their language, route to `examples/protocol-go.md` as the template.

Step 3: Read `concepts/protocol.md` for the exact subjects, envelope, and chunk format — get these right regardless of SDK, because they're what makes agents interoperate.

Step 4: Implement. For hosts: register as service name `agents`, serve the `prompt` endpoint on a queue group, emit heartbeats. For callers: discover via `$SRV`, prompt, consume the typed chunk stream until the zero-byte terminator.

Step 5: If agents need memory or handoff, layer in JetStream/KV per `patterns/durable-state.md`.

Step 6: Wire identity and isolation — pick stable `agent`/`owner`/`name` tokens and use NATS accounts for tenant separation (defer infra to `jetstream-deployment`).

## Core Principles

- **Honor the wire protocol exactly** — service name MUST be `agents`, the `prompt` endpoint MUST use queue group `agents`, every response stream MUST start with a `{"type":"status","data":"ack"}` chunk and MUST end with a **zero-byte message and no headers**. These are what let a caller talk to an agent it has never seen.
- **Never construct endpoint subjects from identity** (except the heartbeat subject `agents.hb.{agent}.{owner}.{name}`, which is fixed). Learn endpoints from the discovery (`$SRV.INFO.agents`) response — addressing is discovery-driven by design.
- **Discovery first, not hardcoded endpoints** — the whole point is that callers don't know agents in advance. Use `$SRV.PING.agents` / `$SRV.INFO.agents`.
- **Stream, don't block** — replies are a stream of typed chunks (`response`, `status`, `query`), consumed as an async iterator. Surface tokens as they arrive.
- **Forward-compatibility is mandatory** — callers MUST silently ignore unknown chunk types and preserve unknown fields. The 0.x protocol will add types; don't crash on them.
- **Use queue groups for horizontal scale** — multiple instances of the same agent share the `agents` queue group so prompts load-balance across them automatically.
- **Heartbeat for liveness** — emit to `agents.hb.*` every ~30s; treat an agent offline after 3× missed intervals. Use the `status` request/reply endpoint to bootstrap liveness without waiting for the next beat.
- **Identity is `agent`/`owner`/`name`(/`session`)** — choose stable, lowercase tokens (`a–z 0–9 - _`), never starting with `$`. These compose the subject namespace and the discovery metadata.
- **Isolate tenants with NATS accounts**, not application logic — multi-tenancy comes from the bus, not your code.
- **Durable state is JetStream/KV, and it's optional** — v0.3 transport is stateless micro; reach for streams/KV only when agents need memory or handoff.
- **Let the SDK own the boilerplate** — prefer `AgentService`/`AgentService` (TS/Py) for the ack, keep-alive, terminator, and error mapping; reach for the raw wire helpers (`encodeChunk`, `splitResponseText`) only for event-driven producers that don't fit a handler. Use `response.ask` / `stream.ask` for mid-stream queries and `extraEndpoints` for controller endpoints rather than hand-rolling either.
- **Don't assume `1MB`** — `max_payload` is broker-negotiated; read it from `$SRV.INFO` and validate on the caller before sending (the SDK raises `PayloadTooLargeError` / `AttachmentsNotSupportedError` locally).
