import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  // jsPublish is auto-imported from nuxt-nats server utils
  await jsPublish('events.demo', {
    message: body.message ?? 'hello from playground',
    ts: Date.now(),
  })

  return { ok: true }
})
