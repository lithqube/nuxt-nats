# Deployment

## Topology overview

```
┌─────────────────┐     HTTP       ┌─────────────────────┐
│   Users         │ ─────────────► │  Nuxt SSR App       │
└─────────────────┘                │  (N replicas)       │
                                   │  publish-only mode  │
                                   └─────────┬───────────┘
                                             │ NATS TCP
                                   ┌─────────▼───────────┐
                                   │  NATS Server        │
                                   │  JetStream enabled  │
                                   └─────────┬───────────┘
                                             │ pull consumers
                                   ┌─────────▼───────────┐
                                   │  Worker Process     │
                                   │  NUXT_NATS_WORKERS  │
                                   │  =true              │
                                   └─────────────────────┘
```

The Nuxt app and worker process share the same build output but run with different environment variables.

## Environment variables

| Variable | Description | Example |
|---|---|---|
| `NUXT_NATS_SERVERS` | Comma-separated server URLs | `nats://nats.internal:4222` |
| `NUXT_NATS_TOKEN` | Auth token | `s3cr3t` |
| `NUXT_NATS_USER` | Username | `app` |
| `NUXT_NATS_PASS` | Password | `s3cr3t` |
| `NUXT_NATS_WORKERS` | Enable consumers | `true` |

Never set credentials in `nuxt.config.ts` for production — use environment variables or a secrets manager.

## Node.js (self-hosted)

Build and run:

```bash
# Build
npm run build

# Run SSR app (publish only)
node .output/server/index.mjs

# Run worker (consumers enabled)
NUXT_NATS_WORKERS=true node .output/server/index.mjs
```

With PM2:

```js
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'nuxt-app',
      script: '.output/server/index.mjs',
      instances: 4,
      env: {
        NUXT_NATS_SERVERS: 'nats://nats.internal:4222',
        NUXT_NATS_TOKEN: process.env.NATS_TOKEN,
      },
    },
    {
      name: 'nuxt-worker',
      script: '.output/server/index.mjs',
      instances: 2,
      env: {
        NUXT_NATS_SERVERS: 'nats://nats.internal:4222',
        NUXT_NATS_TOKEN: process.env.NATS_TOKEN,
        NUXT_NATS_WORKERS: 'true',
      },
    },
  ],
}
```

## Docker

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
# NATS packages are external — node_modules must be present
COPY --from=build /app/.output ./.output
COPY --from=build /app/node_modules ./node_modules
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
```

> **Important:** Do not strip `node_modules` in the runtime image. NATS packages are Nitro externals and are resolved from `node_modules` at runtime.

Docker Compose:

```yaml
services:
  nats:
    image: nats:latest
    command: -js
    ports:
      - "4222:4222"

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      NUXT_NATS_SERVERS: nats://nats:4222
    depends_on:
      - nats

  worker:
    build: .
    environment:
      NUXT_NATS_SERVERS: nats://nats:4222
      NUXT_NATS_WORKERS: "true"
    depends_on:
      - nats
```

## Kubernetes

```yaml
# app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nuxt-app
spec:
  replicas: 3
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: app
          image: your-registry/nuxt-app:latest
          ports:
            - containerPort: 3000
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]   # allow load balancer to drain before SIGTERM
          env:
            - name: NUXT_NATS_SERVERS
              value: nats://nats.nats.svc.cluster.local:4222
            - name: NUXT_NATS_TOKEN
              valueFrom:
                secretKeyRef:
                  name: nats-credentials
                  key: token
---
# worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nuxt-worker
spec:
  replicas: 2
  template:
    spec:
      terminationGracePeriodSeconds: 60   # longer grace period for drain
      containers:
        - name: worker
          image: your-registry/nuxt-app:latest
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]   # let in-flight ops settle before SIGTERM
          env:
            - name: NUXT_NATS_SERVERS
              value: nats://nats.nats.svc.cluster.local:4222
            - name: NUXT_NATS_WORKERS
              value: "true"
            - name: NUXT_NATS_TOKEN
              valueFrom:
                secretKeyRef:
                  name: nats-credentials
                  key: token
```

Set `terminationGracePeriodSeconds` higher for workers than for the app — workers need time to finish in-flight message handlers before SIGKILL. The `preStop` sleep of 5 seconds gives the load balancer time to stop routing new traffic before SIGTERM arrives.

The module registers `process.once('SIGTERM')` which calls `nc.drain()` and `process.exit(0)`. The drain flushes all in-flight publishes and waits for the consumer loop to idle. Total shutdown time = preStop (5s) + drain time ≤ terminationGracePeriodSeconds.

## Vercel / Netlify (serverless)

Publisher-only mode works on serverless platforms. Do not set `NUXT_NATS_WORKERS=true`.

Each function invocation creates a NATS connection, publishes, and disconnects. This adds ~50–200ms cold-start latency per invocation. For high-frequency publish paths, consider a NATS HTTP gateway or Synadia Cloud REST API instead.

Stream provisioning (`provision: 'startup'`) is not recommended on serverless — run provisioning as a one-time setup step instead.

## Cloudflare Workers

Requires WebSocket transport. TCP sockets are not available in the Workers runtime.

```ts
// nuxt.config.ts
nats: {
  transport: 'ws',
  wsServers: ['wss://nats.example.com:443'],
}
```

Your NATS server must have WebSocket enabled:

```conf
# nats-server.conf
websocket {
  port: 443
  tls {
    cert_file: /path/to/cert.pem
    key_file:  /path/to/key.pem
  }
}
```

Bundle size: `@nats-io/nats-core` alone must fit within the Workers bundle limit (~3 MiB). Measure your bundle before deploying. JetStream publish works; consumers are not supported on Workers.

## Bun

Bun's Node.js compatibility layer supports `net.Socket`, so `@nats-io/transport-node` works. The module auto-detects Bun via `globalThis.Bun` and falls back to WebSocket transport — you can override this with `transport: 'tcp'` to force TCP:

```bash
NUXT_NATS_SERVERS=nats://localhost:4222 bun .output/server/index.mjs
```

Bun's reliable SIGTERM handling means the graceful drain is more predictable than Node.js in some configurations.

## TLS

For production NATS servers with TLS enabled, pass certificate paths via `nuxt.config.ts`:

```ts
nats: {
  servers: ['tls://nats.internal:4222'],
  tls: {
    caFile: '/etc/ssl/certs/nats-ca.pem',      // server CA — required if using a private CA
    certFile: '/etc/ssl/certs/client.pem',      // client cert — required for mTLS
    keyFile: '/etc/ssl/private/client-key.pem', // client key  — required for mTLS
  },
}
```

In Kubernetes, mount TLS secrets as volumes and set paths accordingly:

```yaml
containers:
  - name: app
    env:
      - name: NUXT_NATS_SERVERS
        value: tls://nats.nats.svc.cluster.local:4222
    volumeMounts:
      - name: nats-tls
        mountPath: /etc/nats-tls
        readOnly: true
volumes:
  - name: nats-tls
    secret:
      secretName: nats-client-tls
```

```ts
// nuxt.config.ts
nats: {
  tls: {
    caFile: '/etc/nats-tls/ca.crt',
    certFile: '/etc/nats-tls/tls.crt',
    keyFile: '/etc/nats-tls/tls.key',
  },
}
```

> Server TLS (one-way) verifies the server certificate. mTLS (mutual) additionally requires the server to verify the client certificate — use mTLS for zero-trust environments.

## NATS clustering (production)

For production, run a NATS cluster with 3+ nodes and set `replicas: 3` on critical streams:

```ts
nats: {
  servers: [
    'nats://nats-0.nats.svc:4222',
    'nats://nats-1.nats.svc:4222',
    'nats://nats-2.nats.svc:4222',
  ],
  streams: [{
    name: 'ORDERS',
    subjects: ['orders.>'],
    replicas: 3,
    provision: 'never',
  }],
}
```

The NATS client handles failover automatically — if one server is unreachable, it reconnects to another in the list.
