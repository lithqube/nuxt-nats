# TypeScript / Node / Bun Examples

Using `@synadia-ai/agents` (caller) and `@synadia-ai/agent-service` (host), both npm **0.5.2**, released in lockstep. Reference implementation; most mature SDK. Requires Node ≥20 or Bun ≥1.2 and a reachable NATS server.

> APIs are 0.x and may drift — verify the installed version. The **wire protocol** (`concepts/protocol.md`) is the stable contract; if a method name here differs from the installed package, honor the protocol and adjust the call.

Runnable versions of everything below ship in the SDK repo's numbered **agent ladder** — `agent-sdk/typescript/examples/01-echo.ts` → `05-tools.ts` (echo, Ollama, OpenRouter, auto-selecting, tool-calling) — run with `bun examples/01-echo.ts`.

## Install

```bash
# Caller / meta-agent
npm i @synadia-ai/agents @nats-io/transport-node
# Host / agent
npm i @synadia-ai/agent-service @nats-io/transport-node
```

## Host: serve an agent

The host SDK handles micro registration (service name `agents`), the mandatory `ack` chunk, the queue group, heartbeats, and the zero-byte terminator. You supply `onPrompt`.

```ts
import { connect } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";

const nc = await connect({ servers: "nats://localhost:4222" });

const service = new AgentService({
  nc,
  agent: "echo",     // canonical harness id  -> agents.prompt.echo.demo.main
  owner: "demo",
  name: "main",
  description: "demo echo agent",
});

// An agent is just: prompt -> streamed reply.
service.onPrompt(async (envelope, response) => {
  // envelope.prompt is the user text; envelope.attachments if attachments_ok
  await response.send(`echo: ${envelope.prompt}`);
  // multiple sends stream multiple `response` chunks (e.g. token streaming)
});

await service.start();
console.log("agent up — discover with: nats req '$SRV.PING.agents' ''");
// keep the process alive; await service.stop() on shutdown
```

### Wrapping an LLM (streaming tokens)

```ts
service.onPrompt(async (envelope, response) => {
  const stream = await llm.stream(envelope.prompt);     // your model client
  for await (const token of stream) {
    await response.send(token);                          // one `response` chunk per token
  }
});
```

### Asking the caller a question mid-stream (human-in-the-loop)

`PromptResponse.ask(prompt, { timeoutMs })` publishes a `query` chunk into the open stream and awaits one reply (§7). It **throws on timeout** — you decide whether to abort or fall back to a default per §7.3. The returned value is a decoded envelope (`.prompt` holds the caller's answer).

```ts
service.onPrompt(async (envelope, response) => {
  if (isDestructive(envelope.prompt)) {
    let answer;
    try {
      answer = await response.ask("Confirm deletion of 200 files? (yes/no)", { timeoutMs: 30_000 });
    } catch {
      await response.send("No confirmation received — aborted.");
      return; // SDK still emits the terminator
    }
    if (answer.prompt.trim().toLowerCase() !== "yes") {
      await response.send("Aborted.");
      return;
    }
  }
  await response.send(doWork(envelope.prompt));
});
```

### Rejecting decoded-but-unsupported input (`ProtocolError` → 400)

A handler exception maps to `Nats-Service-Error-Code: 500` — **except** a `ProtocolError`, which maps to `400`. Use it to reject bad *client* input without it looking like a server fault:

```ts
import { ProtocolError } from "@synadia-ai/agents";

service.onPrompt(async (envelope, response) => {
  if (envelope.attachments?.length && !weCanHandleAttachments) {
    throw new ProtocolError("attachments not supported by this agent"); // → 400, not 500
  }
  await response.send(doWork(envelope.prompt));
});
```

### Controller agent: custom endpoints (`spawn` / `stop` / `list`)

Beyond the protocol-required `prompt` + `status`, register harness-specific endpoints declaratively with `extraEndpoints` — `start()` validates names against `prompt`/`status` and each other, failing fast on a collision. Subjects are advertised **verbatim** (the SDK does not prefix), so assemble the full `agents.*` subject yourself.

```ts
import { AgentService, type AgentServiceExtraEndpoint } from "@synadia-ai/agent-service";

const spawn: AgentServiceExtraEndpoint = {
  name: "spawn",
  subject: "agents.spawn.echo.demo.main",
  queue: "echo-controllers",
  handler: (err, msg) => {
    if (err) return;
    const id = spawnWorker(); // your logic
    msg.respond(new TextEncoder().encode(JSON.stringify({ id })));
  },
  metadata: { role: "controller" },
};

const service = new AgentService({ nc, agent: "echo", owner: "demo", name: "main", extraEndpoints: [spawn] });
await service.start();
// Escape hatch for runtime-dynamic endpoints (bypasses the duplicate-name guard):
//   service.service.addEndpoint("late-bound", { /* … */ });
```

### Event-driven host (no closed `onPrompt` shape)

When your producer doesn't fit a single handler call (an external SSE stream, a callback bus), drive the wire with the exported helpers instead of `AgentService`. `splitResponseText` is a UTF-8-safe chunker for long replies.

```ts
import { encodeChunk, splitResponseText } from "@synadia-ai/agent-service";

// msg is a ServiceMsg whose .reply is the caller's inbox:
msg.respond(encodeChunk({ type: "status", status: "ack" }));      // mandatory first chunk
for (const part of splitResponseText(bigText, maxBytes)) {
  msg.respond(encodeChunk({ type: "response", text: part }));
}
msg.respond(new Uint8Array(0));                                    // zero-byte terminator
```

## Caller: discover and prompt

```ts
import { connect } from "@nats-io/transport-node";
import { Agents, withAgentReconnectDefaults } from "@synadia-ai/agents";

// withAgentReconnectDefaults: retry forever + wait-on-first-connect, so an
// agent runtime survives broker blips / laptop sleeps instead of giving up
// after ~20s (the transport default). Pure option transform.
const nc = await connect(withAgentReconnectDefaults({ servers: "nats://localhost:4222" }));
const agents = new Agents({ nc });

const [agent] = await agents.discover();          // $SRV.PING/INFO.agents under the hood
if (!agent) throw new Error("no agents on the fabric");

// prompt() pre-flight-validates attachments/size locally and supports
// { attachments, signal, inactivityTimeoutMs }.
for await (const msg of await agent.prompt("hello")) {
  if (msg.type === "response") process.stdout.write(msg.text);
  else if (msg.type === "query") {
    // human-in-the-loop: answer once on the provided reply subject
    nc.publish(msg.data.reply_subject, new TextEncoder().encode("yes"));
  }
  // ignore unknown chunk types — forward-compat is required
}
```

The caller SDK fails **before** the wire when an envelope violates the agent's advertised limits — catch the typed errors:

```ts
import { AttachmentsNotSupportedError, PayloadTooLargeError } from "@synadia-ai/agents/errors";

try {
  for await (const msg of await agent.prompt("describe", { attachments: ["./big.jpg"] })) { /* … */ }
} catch (e) {
  if (e instanceof AttachmentsNotSupportedError) { /* agent's attachments_ok === false; no traffic sent */ }
  else if (e instanceof PayloadTooLargeError) { console.log(`${e.actual} > ${e.limit} bytes`); }
  else throw e;
}
// Both extend ValidationError → NatsAgentError. Import the hierarchy from `@synadia-ai/agents/errors`.
```

## Caller: fan out to a fleet and merge

```ts
const agents = new Agents({ nc });
const all = await agents.discover();
const coders = all.filter(a => ["cc", "opencode", "pi"].includes(a.agent));

const answers = await Promise.all(coders.map(async (agent) => {
  let text = "";
  for await (const msg of await agent.prompt("Refactor this function for clarity")) {
    if (msg.type === "response") text += msg.text;
  }
  return { agent: `${agent.agent}/${agent.owner}/${agent.name}`, text };
}));

for (const a of answers) console.log(`\n=== ${a.agent} ===\n${a.text}`);
```

See `patterns/meta-agent.md` for merge strategies (collect-all / race / quorum) and liveness tracking.

## Notes

- **Identity → subject:** `agent`/`owner`/`name` produce `agents.prompt.{agent}.{owner}.{name}`. Keep tokens lowercase `a–z 0–9 - _`, never leading `$`.
- **Scaling:** start multiple host processes with the same `agent`/`owner` (different `name`) — the `agents` queue group load-balances prompts across them automatically.
- **Attachments:** advertise `attachments_ok` on the host and send `{ filename, content }` with base64 (padded, not URL-safe) from the caller. `filename` must be a plain basename (no `/`, `\`, `..`, absolute paths, NUL) or the host rejects with `400`.
- **Don't construct prompt subjects by hand** in caller code — let `discover()` give you the agent handle; the SDK addresses the discovered subject.
- **Testing:** import `ReferenceAgent` from `@synadia-ai/agent-service/testing` for a spec-compliant counterparty in integration/interop tests (see `patterns/testing.md`).
- **Liveness API:** `agents.liveness(id)`, `agents.onHeartbeat(id, cb)`, `agents.ping(id)` wrap heartbeat tracking and one-shot `$SRV.PING`. Call `agents.close()` on shutdown — it aborts all in-flight streams.
