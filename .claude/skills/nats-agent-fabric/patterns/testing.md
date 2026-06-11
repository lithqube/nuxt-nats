# Pattern: Testing & Interop (ReferenceAgent + wire helpers)

The fabric's value is interoperability — a caller talks to an agent it has never seen. So the load-bearing tests are **wire-level**: does my host produce a stream a foreign caller accepts, and does my caller consume a stream a foreign host produces? The SDKs ship two primitives for exactly this.

## `ReferenceAgent` — a spec-compliant counterparty

A minimal, no-frills agent that implements the full §12 checklist correctly. Use it as the *other end* when testing one side in isolation.

- **TypeScript:** `import { ReferenceAgent } from "@synadia-ai/agent-service/testing"` (it moved here from `@synadia-ai/agents/testing` when the SDK split into caller + host packages).
- **Python:** the runnable `agent-sdk/python/examples/_reference_agent.py` plays the same role — it's the counterparty for the client SDK's numbered demos and cross-SDK interop checks.

```ts
import { connect } from "@nats-io/transport-node";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";

const nc = await connect({ servers: "nats://localhost:4222" });
const ref = new ReferenceAgent({ nc, agent: "echo", owner: "demo", name: "ref", heartbeatIntervalS: 1 });
await ref.start();
// now point your caller-under-test at the fabric and assert on what it does
```

`ReferenceAgent` also accepts a custom `promptHandler` (a raw `ServiceMsg`) so a test can deliberately emit **malformed** shapes — drop the terminator, send an unknown chunk type, skip the leading `ack` — and assert the caller stays compliant (silently ignores unknowns, applies its inactivity timeout, etc.). A real harness should use `AgentService`, not `ReferenceAgent`.

## Cross-language interop is the real contract

A Python caller prompting a TS host (and vice versa) is a tested guarantee, because both speak the same wire protocol. When you add a new host in any language, the SDK's integration tests *are* the conformance suite — wire it against `ReferenceAgent`/`_reference_agent.py` on the opposite side and the wire shape is validated for you. For a language with no SDK, validate the hand-rolled agent (`examples/protocol-go.md`) against an SDK caller the same way.

## Driving the wire directly (event-driven hosts)

When your producer doesn't fit a single `onPrompt(envelope, response)` call — an external SSE stream, a callback bus, a harness that emits out-of-band — skip `AgentService` and emit chunks yourself with the exported helpers:

| Helper | Purpose |
|--------|---------|
| `encodeChunk(chunk)` | Encode a typed `response` / `status` / `query` chunk to wire JSON bytes. |
| `splitResponseText(text, maxBytes, opts?)` | UTF-8-safe chunker for long response payloads (never splits a multi-byte rune). |
| `buildHeartbeatPayload(subject, intervalS, instanceId, opts?)` | Build a §8.3 heartbeat / status payload. |
| `encodeHeartbeatPayload(payload)` | Encode that payload to wire JSON bytes. |
| `DEFAULT_MAX_PAYLOAD` / `DEFAULT_HEARTBEAT_INTERVAL_S` / `DEFAULT_KEEPALIVE_INTERVAL_S` / `DEFAULT_ATTACHMENTS_OK` | Fallback constants. |

You then own the §12 checklist yourself: register the `agents` micro service, emit the leading `{type:"status",data:"ack"}`, stream `response` chunks, publish the **zero-byte, header-less** terminator, and beacon heartbeats. This is how the shipped `openclaw`, `pi`, and `claude-code` channels are built. If you can express your producer as a handler, prefer `AgentService` — it gets the ack, keep-alive, terminator, and error mapping right for free.

## Checklist for a host test

- [ ] First message on the reply subject is `{"type":"status","data":"ack"}`.
- [ ] Stream ends with a **zero-byte, header-less** message — success *and* error paths.
- [ ] A handler exception becomes `500`; a `ProtocolError` becomes `400`; a malformed envelope becomes `400` (before the ack).
- [ ] Heartbeats land on `agents.hb.{agent}.{owner}.{name}` with all §8.3 fields, and `status` request/reply returns the same shape.
- [ ] `$SRV.INFO.agents` shows service name `agents`, the `prompt` endpoint on queue group `agents`, and `max_payload`/`attachments_ok` metadata.
- [ ] An SDK caller on the opposite language discovers and prompts it without special-casing.
