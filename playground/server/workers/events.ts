import type { JsMsg } from '@nats-io/jetstream'

/**
 * Handler for the declarative consumer in nuxt.config's `nats.consumers`.
 *
 * Default-exports the handler. The module generates a Nitro plugin that imports this
 * statically, which is what lets a file under server/workers work at all: Nitro does not
 * scan that directory, so nothing else would ever import it.
 */
export default async function onEvent(msg: JsMsg, payload: unknown) {
  console.log('[playground] events consumer got', payload)
  msg.ack()
}
