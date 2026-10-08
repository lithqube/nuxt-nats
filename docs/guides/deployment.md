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
| `NUXT_NATS_SERVERS` | Comma-separated server URLs | `nats://a:4222,nats://b:4222` |
| `NUXT_NATS_WS_SERVERS` | Comma-separated WebSocket URLs | `wss://nats.example.com` |
| `NUXT_NATS_TRANSPORT` | `auto`, `tcp` or `ws` | `ws` |
| `NUXT_NATS_NAME` | Connection name (default `nuxt-nats@<hostname>:<pid>`) | `checkout-api` |
| `NUXT_NATS_CREDS_FILE` | Path to a `.creds` file, re-read on every reconnect | `/run/secrets/nats/user.creds` |
| `NUXT_NATS_CREDS` | `.creds` contents, raw or base64 | `LS0tLS1CRUdJTi...` |
| `NUXT_NATS_TOKEN` | Auth token | `s3cr3t` |
| `NUXT_NATS_USER` | Username | `app` |
| `NUXT_NATS_PASS` | Password | `s3cr3t` |
| `NUXT_NATS_USER_JWT` | User JWT credential | `eyJ0eXAi...` |
| `NUXT_NATS_NKEY_SEED` | NKey seed (Ed25519) | `SUAM...` |
| `NUXT_NATS_WORKERS` | Enable consumers/agents | `true` |
| `NUXT_NATS_CREDENTIALS_PROVIDER` | `static`, `infisical`, `synadia` or `custom` | `infisical` |
| `NUXT_NATS_CREDENTIALS_*` | Any other `nats.credentials` leaf | `NUXT_NATS_CREDENTIALS_INFISICAL_AUTH_IDENTITY_ID` |
| `NUXT_NATS_HEALTH_DETAILS` | Add credential-provider status to health | `true` |
| `NUXT_NATS_SYNADIA_API_TOKEN` / `_URL` | Control Plane access for `useSynadiaCloud()` | |

Never set credentials in `nuxt.config.ts` for production — values there (even `process.env.X` read there) are baked into the build output, and the module warns on a build. Use runtime environment variables, a mounted creds file, or a [credentials provider](./credentials-rotation.md).

Requires Node.js `^20.19.0 || >= 22.12.0`. For Synadia Cloud specifics (endpoints, plan limits, the per-instance connection budget) see the [Synadia Cloud guide](./synadia-cloud.md).

> **Multi-server failover:** `NUXT_NATS_SERVERS` accepts a comma-separated list (e.g. `nats://a:4222,nats://b:4222,nats://c:4222`). The module splits the value into an array before passing it to the NATS client. Alternatively, set `servers` as an array in `nuxt.config.ts`. The client handles failover automatically — if one server is unreachable, it reconnects to the next in the list.

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

### Credentials from a Secret volume

Mount the `.creds` file instead of passing a token. The module re-reads the file on every reconnect, and Kubernetes updates a mounted Secret in place, so a rotated credential is picked up without restarting pods:

```yaml
          env:
            - name: NUXT_NATS_CREDS_FILE
              value: /run/secrets/nats/user.creds
          volumeMounts:
            - { name: nats-creds, mountPath: /run/secrets/nats, readOnly: true }
      volumes:
        - name: nats-creds
          secret: { secretName: nats-user-creds }   # key: user.creds
```

For short-lived creds fetched at runtime (Infisical with the pod's service-account identity, no stored secret at all) use a [credentials provider](./credentials-rotation.md), and rotate them with the [`nuxt-nats-rotate` CronJob](./credentials-rotation.md#kubernetes-cronjob).

Set `terminationGracePeriodSeconds` higher for workers than for the app so the connection drain has room to finish before SIGKILL. The `preStop` sleep of 5 seconds gives the load balancer time to stop routing new traffic before SIGTERM arrives.

On `SIGTERM` (or `SIGINT`) the module stops agents, stops the consumer loops, calls `nc.drain()`, stops any credential refreshes, then `process.exit(0)`. The drain flushes pending publishes and acks before closing the connection. It does not wait for handlers that are still running: a message whose handler has not acked by the time the connection closes is redelivered after `ackWait`, so handlers should be idempotent. Total shutdown time = preStop (5s) + drain time ≤ terminationGracePeriodSeconds.

## Vercel / Netlify (serverless)

Publisher-only mode works on serverless platforms. Do not set `NUXT_NATS_WORKERS=true`.

The module connects once per function instance, when it boots, and reuses that connection for every invocation the instance serves. Cold starts pay the connect (~50–200 ms, more with a credentials provider fetching first), and every warm instance holds a connection, which counts against connection limits such as Synadia Cloud's per-plan cap. For very spiky or high-fan-out publish paths, consider a NATS HTTP gateway instead.

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

Bun's Node.js compatibility layer supports `net.Socket`, so `@nats-io/transport-node` works. Under the default `transport: 'auto'`, though, the module detects Bun via `globalThis.Bun` and uses the WebSocket transport, connecting to `wsServers` (or to `servers` when `wsServers` is empty). Either point it at a WebSocket listener, or force TCP:

```bash
# WebSocket (the 'auto' default on Bun) — the NATS server needs a websocket {} block
NUXT_NATS_WS_SERVERS=ws://localhost:8080 bun .output/server/index.mjs

# TCP
NUXT_NATS_TRANSPORT=tcp NUXT_NATS_SERVERS=nats://localhost:4222 bun .output/server/index.mjs
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
