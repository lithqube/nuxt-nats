# ADR-005: Manual SIGTERM/SIGINT handlers alongside Nitro close hook

**Status:** Accepted  
**Date:** 2026-05-11

## Context

Proper NATS connection shutdown requires calling `nc.drain()`, which:

1. Stops accepting new messages on subscriptions
2. Flushes all pending outbound messages
3. Waits for all in-flight PubAck responses
4. Closes the connection

Skipping drain and calling `nc.close()` directly — or letting the process exit — leaves the server with unacknowledged messages that will be redelivered after `ackWait` expires.

Nuxt/Nitro provides a `close` hook on `nitroApp.hooks` intended for cleanup:

```ts
nitroApp.hooks.hook('close', async () => { /* cleanup */ })
```

However, as of Nitro v2 / Nuxt v4, this hook is **not reliably called when the process receives SIGTERM** in the node-server preset. This is tracked in [nitrojs/nitro#4015](https://github.com/nitrojs/nitro/issues/4015) (open as of 2026-05).

In Kubernetes, the default termination flow sends SIGTERM to the process and expects it to exit within the `terminationGracePeriodSeconds` window. If Nitro's close hook doesn't fire, NATS messages in-flight at shutdown time will be redelivered.

## Decision

Register **both** the Nitro close hook and manual `process.once` signal handlers. The first one to fire wins:

```ts
// Nitro close hook — fires on graceful Nuxt shutdown, not reliably on SIGTERM
nitroApp.hooks.hook('close', async () => {
  await drainAndClose()
})

// Manual handlers — reliable on SIGTERM/SIGINT from OS, Kubernetes, Docker
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
```

`drainAndClose()` is idempotent — it checks `_isClosing` before proceeding:

```ts
async function drainAndClose() {
  if (_isClosing || !_nc) return
  _isClosing = true
  await _nc.drain()
  _nc = _js = _jsm = undefined
  _isClosing = false
}
```

## Consequences

- **Reliable drain on Kubernetes SIGTERM.** Pods receive SIGTERM before forced SIGKILL; the handler fires during the grace period.
- **No double-drain.** `_isClosing` guard prevents concurrent drain calls if both hooks fire.
- **`process.once` is used, not `process.on`.** Signal handlers are registered once and removed after firing, preventing accumulation if the Nitro plugin is somehow re-executed.
- **Trade-off: `process.exit(0)` is called from the signal handler.** This is necessary because Node.js won't exit automatically when async cleanup is done from a signal handler without an explicit `exit()`. The process is already shutting down — this is intentional.

## When this is resolved upstream

When [nitrojs/nitro#4015](https://github.com/nitrojs/nitro/issues/4015) is fixed and the close hook fires reliably on SIGTERM, the manual signal handlers become redundant but harmless. They can be removed in a future minor version.
