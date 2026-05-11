# ADR-006: Mark @nats-io/* packages as Nitro externals

**Status:** Accepted  
**Date:** 2026-05-11

## Context

Nitro bundles server code by default using Rollup. This produces a self-contained output in `.output/server/` that doesn't require `node_modules` at runtime.

`@nats-io/transport-node` uses Node.js's built-in `net` module to create TCP sockets. When Rollup attempts to bundle this package, it cannot resolve `net` (a built-in), and even when it does, the bundled code behaves differently from the original because:

- `net.Socket` prototype chains are severed in some bundler configurations
- The package uses conditional imports and dynamic requires that Rollup doesn't handle cleanly
- The resulting bundle fails at runtime with `Cannot read properties of undefined` errors in socket initialization

The same applies to the other `@nats-io/*` packages due to internal cross-package imports.

## Decision

Register all `@nats-io/*` packages as `externals.external` in Nitro's config via the `nitro:config` hook:

```ts
nuxt.hook('nitro:config', (nitroConfig) => {
  nitroConfig.externals ??= {}
  nitroConfig.externals.external ??= []
  const natsPackages = [
    '@nats-io/nats-core',
    '@nats-io/transport-node',
    '@nats-io/jetstream',
    '@nats-io/kv',
    '@nats-io/obj',
    '@nats-io/nkeys',
  ]
  for (const pkg of natsPackages) {
    if (!nitroConfig.externals.external.includes(pkg)) {
      nitroConfig.externals.external.push(pkg)
    }
  }
})
```

This tells Nitro to leave `require('@nats-io/transport-node')` calls as-is in the output, resolving them from `node_modules` at runtime.

## Consequences

- **`node_modules` must be present at runtime.** Deployments that strip `node_modules` after build (e.g., some Docker multi-stage builds) must install production dependencies in the final image. The `package.json` lists NATS packages under `dependencies`, not `devDependencies`, which ensures they are included in `npm install --production`.
- **Nitro's `node-server` preset works correctly.** The standalone server output includes a reference to `node_modules` for external resolution.
- **Serverless presets may need adjustment.** Vercel/Netlify presets bundle differently. Users targeting these platforms with `transport: 'ws'` (no TCP socket issue) may need to experiment with preset-specific external configuration.
- **No Cloudflare Workers bundling.** Workers have strict bundle size and module restrictions. The external approach doesn't apply — users targeting Workers must use `transport: 'ws'` and ensure their bundler resolves `@nats-io/nats-core` correctly for the Workers runtime.

## Alternatives considered

**Patch the transport-node package with a custom rollup plugin:** Too fragile, breaks on package updates. Rejected.

**Use a pure-JS NATS implementation:** No such implementation exists for JetStream that matches the feature set of the official SDK. Rejected.

**Ship a pre-bundled NATS shim:** Would require maintaining a separate build pipeline for the NATS client code. Rejected for v1.
