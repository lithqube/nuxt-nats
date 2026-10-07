type ConnectErrorHook = (err: Error) => void | Promise<void>
type ReconnectHook = (server: string) => void | Promise<void>
type DisconnectHook = (server: string) => void | Promise<void>
type CredentialsRefreshedHook = (info: { expiresAt?: number, changed: boolean }) => void | Promise<void>
type CredentialsErrorHook = (err: Error) => void | Promise<void>

const _connectErrorHooks: ConnectErrorHook[] = []
const _reconnectHooks: ReconnectHook[] = []
const _disconnectHooks: DisconnectHook[] = []
const _credentialsRefreshedHooks: CredentialsRefreshedHook[] = []
const _credentialsErrorHooks: CredentialsErrorHook[] = []

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
  /** Called once per outage, when the client reconnects after a disconnect. Repeat reconnect statuses with no disconnect in between are not forwarded (nats.js#423). */
  onReconnect?: ReconnectHook
  /** Called each time the client loses its connection to a server. */
  onDisconnect?: DisconnectHook
  /** Called after a credentials provider returned usable credentials. `changed` is false when they were the same. */
  onCredentialsRefreshed?: CredentialsRefreshedHook
  /** Called when a credentials provider fetch fails. The error carries no secret material. */
  onCredentialsError?: CredentialsErrorHook
}) {
  if (hooks.onConnectError) _connectErrorHooks.push(hooks.onConnectError)
  if (hooks.onReconnect) _reconnectHooks.push(hooks.onReconnect)
  if (hooks.onDisconnect) _disconnectHooks.push(hooks.onDisconnect)
  if (hooks.onCredentialsRefreshed) _credentialsRefreshedHooks.push(hooks.onCredentialsRefreshed)
  if (hooks.onCredentialsError) _credentialsErrorHooks.push(hooks.onCredentialsError)
}

export function _fireConnectError(err: Error) {
  for (const h of _connectErrorHooks) {
    try {
      Promise.resolve(h(err)).catch((_e) => { /* async hook rejection — isolated */ })
    }
    catch { /* sync hook throw — isolated */ }
  }
}

export function _fireReconnect(server: string) {
  for (const h of _reconnectHooks) {
    try {
      Promise.resolve(h(server)).catch((_e) => { /* async hook rejection — isolated */ })
    }
    catch { /* sync hook throw — isolated */ }
  }
}

export function _fireDisconnect(server: string) {
  for (const h of _disconnectHooks) {
    try {
      Promise.resolve(h(server)).catch((_e) => { /* async hook rejection — isolated */ })
    }
    catch { /* sync hook throw — isolated */ }
  }
}

export function _fireCredentialsRefreshed(info: { expiresAt?: number, changed: boolean }) {
  for (const h of _credentialsRefreshedHooks) {
    try {
      Promise.resolve(h(info)).catch((_e) => { /* async hook rejection — isolated */ })
    }
    catch { /* sync hook throw — isolated */ }
  }
}

export function _fireCredentialsError(err: Error) {
  for (const h of _credentialsErrorHooks) {
    try {
      Promise.resolve(h(err)).catch((_e) => { /* async hook rejection — isolated */ })
    }
    catch { /* sync hook throw — isolated */ }
  }
}

/** For testing only — resets all registered hooks. */
export function _clearNatsHooks() {
  _connectErrorHooks.length = 0
  _reconnectHooks.length = 0
  _disconnectHooks.length = 0
  _credentialsRefreshedHooks.length = 0
  _credentialsErrorHooks.length = 0
}
