type ConnectErrorHook = (err: Error) => void | Promise<void>
type ReconnectHook = (server: string) => void | Promise<void>
type DisconnectHook = (server: string) => void | Promise<void>

const _connectErrorHooks: ConnectErrorHook[] = []
const _reconnectHooks: ReconnectHook[] = []
const _disconnectHooks: DisconnectHook[] = []

/**
 * Register callbacks for NATS connection lifecycle events.
 *
 * Call this in a Nitro plugin (server/plugins/*.ts) or server middleware.
 * Multiple calls accumulate — all registered hooks are called in order.
 *
 * @example
 *   // server/plugins/nats-hooks.ts
 *   export default defineNitroPlugin(() => {
 *     useNatsHooks({
 *       onConnectError: (err) => logger.error('NATS connect failed', err),
 *       onReconnect: (server) => metrics.increment('nats.reconnect'),
 *       onDisconnect: (server) => logger.warn('NATS disconnected from', server),
 *     })
 *   })
 */
export function useNatsHooks(hooks: {
  /** Called when the initial connection attempt fails. */
  onConnectError?: ConnectErrorHook
  /** Called each time the client successfully reconnects after a disconnect. */
  onReconnect?: ReconnectHook
  /** Called each time the client loses its connection to a server. */
  onDisconnect?: DisconnectHook
}) {
  if (hooks.onConnectError) _connectErrorHooks.push(hooks.onConnectError)
  if (hooks.onReconnect) _reconnectHooks.push(hooks.onReconnect)
  if (hooks.onDisconnect) _disconnectHooks.push(hooks.onDisconnect)
}

export function _fireConnectError(err: Error) {
  for (const h of _connectErrorHooks) {
    try { Promise.resolve(h(err)).catch(() => {}) }
    catch { /* hook errors must not affect the module */ }
  }
}

export function _fireReconnect(server: string) {
  for (const h of _reconnectHooks) {
    try { Promise.resolve(h(server)).catch(() => {}) }
    catch {}
  }
}

export function _fireDisconnect(server: string) {
  for (const h of _disconnectHooks) {
    try { Promise.resolve(h(server)).catch(() => {}) }
    catch {}
  }
}

/** For testing only — resets all registered hooks. */
export function _clearNatsHooks() {
  _connectErrorHooks.length = 0
  _reconnectHooks.length = 0
  _disconnectHooks.length = 0
}
