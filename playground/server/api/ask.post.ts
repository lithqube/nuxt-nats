import { defineEventHandler, readBody } from 'h3'

// Caller side: discover agents on the bus and prompt the first one, collecting
// the streamed response. useAgents() is auto-imported from nuxt-nats.
//
//   curl -X POST localhost:3000/api/ask -d '{"prompt":"hello"}' -H 'content-type: application/json'
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const promptText = body?.prompt ?? 'hello'

  const agents = useAgents()
  const found = await agents.discover()
  if (!found.length) {
    return { ok: false, error: 'no agents on the fabric — start one with NUXT_NATS_WORKERS=true' }
  }

  const target = found[0]!
  let text = ''
  for await (const msg of await target.prompt(promptText)) {
    if (msg.type === 'response') text += msg.text
    // ignore status/query/unknown chunk types for this simple demo
  }

  return {
    ok: true,
    agent: `${target.agent}/${target.owner}/${target.name}`,
    response: text,
  }
})
