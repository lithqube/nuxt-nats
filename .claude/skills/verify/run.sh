#!/usr/bin/env bash
# Run the nuxt-nats verification gate and print one pass/fail table.
# Usage: .claude/skills/verify/run.sh [--quick] [--live]
#   --quick  lint, unit, types only (no builds, no Docker)
#   --live   also run the Synadia Cloud live tests (needs the Keychain PAT, see SKILL.md)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

QUICK=0; LIVE=0
for a in "$@"; do
  case "$a" in
    --quick) QUICK=1 ;;
    --live) LIVE=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nuxt-nats-verify.XXXXXX")"
declare -a NAMES RESULTS
FAILED=0

step() { # name, command...
  local name="$1"; shift
  local log="$LOG_DIR/${name// /_}.log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    RESULTS+=("PASS  $(printf '%-12s' "$name") $((SECONDS - start))s")
  else
    RESULTS+=("FAIL  $(printf '%-12s' "$name") $((SECONDS - start))s  log: $log")
    FAILED=1
  fi
}

# `docker info` can hang when the daemon is wedged; give it 10 s (macOS has no `timeout`).
docker_ok() {
  docker info >/dev/null 2>&1 & local pid=$!
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid"; return $?; }
    sleep 0.5
  done
  kill "$pid" 2>/dev/null
  return 1
}

# OrbStack: Testcontainers cannot find the runtime strategy without these.
if [[ -S "$HOME/.orbstack/run/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
fi

step "prepare" npm run dev:prepare
step "lint" npm run lint
step "unit" npm test
step "types" npm run test:types
if [[ $QUICK -eq 0 ]]; then
  step "coverage" npm run test:coverage
  step "prepack" npm run prepack
  step "playground" npm run dev:build
  if docker_ok; then
    step "integration" npm run test:integration
  else
    RESULTS+=("SKIP  integration  Docker not responding (start or restart OrbStack)")
    FAILED=1
  fi
fi
if [[ $LIVE -eq 1 ]]; then
  if [[ -z "${SYNADIA_NATS_USER_ID:-}${SYNADIA_CREDS_FILE:-}" ]]; then
    RESULTS+=("SKIP  live         set SYNADIA_NATS_USER_ID (node scripts/synadia-creds.mjs list) or SYNADIA_CREDS_FILE")
    FAILED=1
  else
    step "live" env SYNADIA_LIVE=1 npm run test:live
  fi
fi

echo
printf '%s\n' "${RESULTS[@]}"
# Test counts from the logs, when present.
for f in unit integration live; do
  [[ -f "$LOG_DIR/$f.log" ]] && grep -hE "^\s+Tests " "$LOG_DIR/$f.log" | tail -1 | sed "s/^ */$f: /"
done
echo "logs: $LOG_DIR"
exit $FAILED
