// Hosts a demo agent on the NATS bus using the Synadia Agent Protocol.
// Runs only when NUXT_NATS_WORKERS=true (an agent is a long-lived micro
// service that beacons heartbeats — wrong for serverless).
//
// Discover it:   nats req '$SRV.PING.agents' '' --replies 0
// Prompt it:     nats req agents.prompt.nuxt-echo.playground.dev 'hello'
//
// defineNatsAgent is auto-imported from the nuxt-nats server utils.
export default defineNitroPlugin(() => {
  defineNatsAgent({
    agent: 'nuxt-echo',
    owner: 'playground',
    name: 'dev',
    description: 'nuxt-nats playground echo agent',
    heartbeatIntervalS: 10,
    async onPrompt(envelope, response) {
      // Mid-stream human-in-the-loop: confirm before "destructive" prompts.
      if (/delete|drop|destroy/i.test(envelope.prompt)) {
        try {
          const answer = await response.ask(`Confirm: "${envelope.prompt}"? (yes/no)`, { timeoutMs: 15_000 })
          if (answer.prompt.trim().toLowerCase() !== 'yes') {
            await response.send('Aborted.')
            return
          }
        }
        catch {
          await response.send('No confirmation received — aborted.')
          return
        }
      }

      // Stream the echo back a word at a time to demonstrate chunked responses.
      for (const word of `echo: ${envelope.prompt}`.split(' ')) {
        await response.send(word + ' ')
      }
    },
  })
})
