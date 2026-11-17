#!/usr/bin/env bash
# Pack the module, then install the tarball into a clean Nuxt app and type-check it.
# Catches what in-repo tests cannot: files missing from (or leaking into) the package, a CLI that
# lost its shebang, and published types that no longer support a consumer's NatsEvents augmentation.
#
#   scripts/package-check.sh            pack + inspect + install + type-check
#   AUDIT=1 scripts/package-check.sh    also `npm audit` the module's runtime dependencies alone
#   NUXT_VERSION='~4.6.0' ...           the Nuxt range the consumer installs (default ~4.6.0)
set -euo pipefail
cd "$(dirname "$0")/.."

NUXT_VERSION=${NUXT_VERSION:-~4.6.0}
# Resolve symlinks (macOS /var -> /private/var): TypeScript treats the two spellings as different
# files, loads the module's .d.ts twice, and merges the consumer's augmentation into only one copy.
WORK=$(cd "$(mktemp -d)" && pwd -P)
if [ -n "${KEEP:-}" ]; then echo "keeping $WORK"; else trap 'rm -rf "$WORK"' EXIT; fi

echo "== build and pack"
npm run prepack --silent
TARBALL="$WORK/$(npm pack --pack-destination "$WORK" --silent | tail -1)"
tar tzf "$TARBALL" | sed 's#^package/##' | sort >"$WORK/files.txt"

echo "== inspect $(wc -l <"$WORK/files.txt" | tr -d ' ') files"
for need in dist/module.mjs dist/types.d.mts dist/runtime/cli/bin.js package.json README.md LICENSE CHANGELOG.md; do
  grep -qx "$need" "$WORK/files.txt" || { echo "FAIL: missing $need"; exit 1; }
done
if grep -E '^(src|test|playground|openapi|scripts|docs|skills|\.claude|\.github)/|\.creds$' "$WORK/files.txt"; then
  echo "FAIL: files that must not be published"; exit 1
fi
tar xzOf "$TARBALL" package/dist/runtime/cli/bin.js | head -1 | grep -q '^#!/usr/bin/env node' \
  || { echo "FAIL: dist/runtime/cli/bin.js lost its shebang"; exit 1; }

if [ "${AUDIT:-}" = 1 ]; then
  echo "== audit the runtime dependencies alone"
  mkdir "$WORK/runtime" && (cd "$WORK/runtime" && npm init -y >/dev/null && npm install --ignore-scripts --silent "$TARBALL" && npm audit)
fi

echo "== consumer: Nuxt $NUXT_VERSION + the packed module"
C="$WORK/consumer"; mkdir -p "$C/app" "$C/server/api" "$C/shared/types"
TS=$(node -p "require('./package.json').devDependencies.typescript")
VTSC=$(node -p "require('./package.json').devDependencies['vue-tsc']")
cat >"$C/package.json" <<EOF
{ "name": "consumer", "private": true, "type": "module",
  "dependencies": { "nuxt": "$NUXT_VERSION", "nuxt-nats": "file:$TARBALL" },
  "devDependencies": { "typescript": "$TS", "vue-tsc": "$VTSC" } }
EOF
cat >"$C/nuxt.config.ts" <<'EOF'
export default defineNuxtConfig({
  modules: ['nuxt-nats'],
  compatibilityDate: '2026-01-01',
  nats: { servers: ['nats://localhost:4222'] },
})
EOF
echo '<template><div /></template>' >"$C/app/app.vue"
# Nuxt 4 type-checks through project references to the files `nuxt prepare` generates.
cat >"$C/tsconfig.json" <<'EOF'
{
  "files": [],
  "references": [
    { "path": "./.nuxt/tsconfig.app.json" },
    { "path": "./.nuxt/tsconfig.server.json" },
    { "path": "./.nuxt/tsconfig.shared.json" },
    { "path": "./.nuxt/tsconfig.node.json" }
  ]
}
EOF
# shared/ rather than server/: Nuxt 4's app project also type-checks server/api files, so the
# augmentation must be visible to it too (see docs/guides/typed-events.md).
cat >"$C/shared/types/nats.d.ts" <<'EOF'
import type {} from 'nuxt-nats'

declare module 'nuxt-nats' {
  interface NatsEvents {
    'orders.created': { id: string, total: number }
  }
}
EOF
cat >"$C/server/api/orders.post.ts" <<'EOF'
export default defineEventHandler(async () => {
  await jsPublish('orders.created', { id: '1', total: 2 })
  // @ts-expect-error the augmentation from the built types must reject a wrong payload
  await jsPublish('orders.created', { nope: true })
  defineNatsConsumer({
    stream: 'ORDERS',
    durable: 'billing',
    async handler(msg, payload) {
      void payload
      msg.ack()
    },
  })
  return { ok: true }
})
EOF
(cd "$C" && npm install --silent --no-audit --no-fund --ignore-scripts && npx nuxt prepare && npx nuxt typecheck)
echo "PASS package-check"
