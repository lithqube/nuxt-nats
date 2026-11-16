#!/usr/bin/env bash
# Smoke-test the built playground under Bun against a real NATS server (TCP and WebSocket).
# Needs: `npm run dev:build` done, docker, bun (override with BUN=/path/to/bun), curl, node.
# Per transport it checks: health reports JetStream, jsPublish works, the declarative consumer
# receives a message, and SIGTERM drains and exits 0.
set -uo pipefail
cd "$(dirname "$0")/.."

BUN=${BUN:-bun}
TCP_PORT=${TCP_PORT:-14222}
WS_PORT=${WS_PORT:-18080}
APP_PORT=${APP_PORT:-3111}
NAME=nuxt-nats-bun-smoke
WORK=$(mktemp -d)
FAILED=0

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT

[ -f playground/.output/server/index.mjs ] || { echo "run 'npm run dev:build' first"; exit 2; }
echo "bun $($BUN --version)"

cat >"$WORK/nats.conf" <<'EOF'
port: 4222
jetstream { store_dir: /tmp/js }
websocket { port: 8080, no_tls: true }
EOF
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p 127.0.0.1:"$TCP_PORT":4222 -p 127.0.0.1:"$WS_PORT":8080 \
  -v "$WORK/nats.conf":/nats.conf:ro nats:2.10-alpine -c /nats.conf >/dev/null || exit 2
for _ in $(seq 40); do curl -s -o /dev/null -m1 "http://127.0.0.1:$WS_PORT" && break; sleep 0.5; done

publish() { # one message on the consumer's subject, so the handler has something to receive
  node --input-type=module -e "
    import { connect } from '@nats-io/transport-node'
    import { jetstream } from '@nats-io/jetstream'
    const nc = await connect({ servers: '127.0.0.1:$TCP_PORT' })
    await jetstream(nc).publish('events.created', JSON.stringify({ label: '$1' }))
    await nc.drain()"
}

check() { # name, then env assignments for the app
  local label=$1; shift
  local log="$WORK/$label.log" health emit pid code
  # The stream is provisioned by the app on first boot, so the very first publish may find none.
  publish "$label" 2>/dev/null || true
  env PORT="$APP_PORT" NUXT_NATS_WORKERS=true "$@" "$BUN" playground/.output/server/index.mjs >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 40); do
    health=$(curl -s -m2 "http://127.0.0.1:$APP_PORT/api/_nats/health")
    echo "$health" | grep -q '"jetstream":{"available":true' && break
    sleep 0.5
  done
  publish "$label" || echo "publish failed"
  emit=$(curl -s -m5 -X POST "http://127.0.0.1:$APP_PORT/api/emit" -H 'content-type: application/json' -d '{}')
  for _ in $(seq 20); do grep -q "events consumer got" "$log" && break; sleep 0.5; done
  kill -TERM "$pid"
  for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; code=hung; else wait "$pid"; code=$?; fi

  local ok=1
  echo "$health" | grep -q '"connected":true' || ok=0
  echo "$health" | grep -q '"jetstream":{"available":true' || ok=0
  [ "$emit" = '{"ok":true}' ] || ok=0
  grep -q "events consumer got" "$log" || ok=0
  grep -q "draining NATS connection" "$log" || ok=0
  [ "$code" = 0 ] || ok=0
  if [ "$ok" = 1 ]; then echo "PASS $label"; else echo "FAIL $label (exit=$code)"; echo "health: $health"; echo "emit: $emit"; cat "$log"; FAILED=1; fi
}

check bun-tcp NUXT_NATS_TRANSPORT=tcp NUXT_NATS_SERVERS="nats://127.0.0.1:$TCP_PORT"
check bun-ws NUXT_NATS_TRANSPORT=ws NUXT_NATS_WS_SERVERS="ws://127.0.0.1:$WS_PORT"
# 'auto' must pick WebSocket on Bun: only a WebSocket server is reachable here
check bun-auto NUXT_NATS_TRANSPORT=auto NUXT_NATS_SERVERS=nats://127.0.0.1:1 NUXT_NATS_WS_SERVERS="ws://127.0.0.1:$WS_PORT"

exit $FAILED
