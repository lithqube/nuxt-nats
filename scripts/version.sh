#!/usr/bin/env bash
# scripts/version.sh — print the canonical nuxt-nats version.
#
# Single source of truth: the `version` field in package.json.
#
# Usage:
#   scripts/version.sh                # 0.1.0-alpha.1
#   scripts/version.sh --with-sha     # 0.1.0-alpha.1-abc1234
#   scripts/version.sh --tag          # v0.1.0-alpha.1
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" || ! -f "$REPO_ROOT/package.json" ]]; then
    echo "Error: scripts/version.sh must run inside the nuxt-nats checkout." >&2
    exit 1
fi

if command -v node >/dev/null 2>&1; then
    VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
elif command -v jq >/dev/null 2>&1; then
    VERSION=$(jq -r .version "$REPO_ROOT/package.json")
else
    VERSION=$(grep -m1 '"version"' "$REPO_ROOT/package.json" \
                | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')
fi

if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
    echo "Error: could not read package.json version." >&2
    exit 1
fi

case "${1:-}" in
    --with-sha)
        SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
        echo "${VERSION}-${SHA}"
        ;;
    --tag)
        echo "v${VERSION}"
        ;;
    "")
        echo "$VERSION"
        ;;
    *)
        echo "Usage: $(basename "$0") [--with-sha | --tag]" >&2
        exit 1
        ;;
esac
