import { Agents } from '@synadia-ai/agents'
import { getNatsConnection } from '../plugins/_connection'

let _agents: Agents | undefined

/**
 * Caller-side client for the Synadia Agent Protocol — discover and prompt
 * agents on the bus over the module's NATS connection.
 *
 * Returns a process-wide cached {@link Agents} client (it subscribes to the
 * heartbeat wildcard for liveness tracking, so reusing one instance avoids
 * duplicate subscriptions). Closed automatically on shutdown via
 * {@link closeAgents}.
 *
 * @example
 *   const agents = useAgents()
 *   const found = await agents.discover()
 *   for await (const msg of await found[0]!.prompt('summarize the incident')) {
 *     if (msg.type === 'response') process.stdout.write(msg.text)
 *   }
 */
export function useAgents(): Agents {
  const nc = getNatsConnection()
  if (!nc) {
    throw new Error('[nuxt-nats] NATS connection is not available. Ensure the nuxt-nats module is configured and the server has fully started.')
  }
  return (_agents ??= new Agents({ nc }))
}

/**
 * Tear down the cached caller client, aborting any in-flight prompt streams.
 * Called automatically on shutdown before the connection drains.
 */
export async function closeAgents(): Promise<void> {
  const agents = _agents
  _agents = undefined
  try {
    await agents?.close()
  }
  catch (err) {
    console.error('[nuxt-nats] Error closing agents client:', err)
  }
}
