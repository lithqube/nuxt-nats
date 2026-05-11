#!/usr/bin/env bash
set -euo pipefail

#######################################
# CONFIG / DEFAULTS
#######################################
DRY_RUN=false
SKIP_BACKUP=false
AUTO_CONFIRM=false

#######################################
# HELP
#######################################
usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --dry-run       Run without rewriting history
  --no-backup     Skip mirror backup (NOT recommended)
  --yes           Skip confirmation prompt
  -h, --help      Show this help

Example:
  $(basename "$0") --yes
EOF
}

#######################################
# ARG PARSING
#######################################
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-backup) SKIP_BACKUP=true ;;
    --yes) AUTO_CONFIRM=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

#######################################
# VALIDATION
#######################################
echo "🔍 Validating environment..."

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "❌ Error: not inside a Git repository"
  exit 1
}

command -v git-filter-repo >/dev/null 2>&1 || {
  echo "❌ Error: git-filter-repo is not installed"
  exit 1
}

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Error: working tree is dirty. Commit or stash changes first."
  exit 1
fi

#######################################
# CONFIRMATION
#######################################
if [ "$AUTO_CONFIRM" = false ]; then
  echo "⚠️ WARNING: This will rewrite Git history."
  echo "⚠️ All commit SHAs will change."
  echo "⚠️ Recommended: run on a fresh clone."

  read -p "Type 'yes' to continue: " confirm
  [[ "$confirm" == "yes" ]] || {
    echo "Aborted."
    exit 1
  }
fi

#######################################
# BACKUP
#######################################
if [ "$SKIP_BACKUP" = false ]; then
  backup_dir="../repo-backup-$(date +%s)"
  echo "📦 Creating mirror backup at: $backup_dir"
  git clone --mirror . "$backup_dir"
else
  echo "⚠️ Skipping backup (user override)"
fi

#######################################
# DETECT CALLBACK API
#######################################
echo "🔎 Detecting git-filter-repo API..."

if git filter-repo -h 2>&1 | grep -qi "return.*message"; then
  API_MODE="legacy"
  echo "→ Using legacy return-based API"
else
  API_MODE="modern"
  echo "→ Using commit object API"
fi

#######################################
# BUILD CALLBACK
#######################################
if [ "$API_MODE" = "legacy" ]; then
  CALLBACK=$(cat <<'EOF'
import re
msg = message.decode("utf-8")

# Remove Co-authored-by trailers (robust match)
msg = re.sub(
    r"(?im)^\s*Co-authored-by:\s+.+?<.+?>\s*$\n?",
    "",
    msg
)

# Normalize spacing
msg = re.sub(r"\n{3,}", "\n\n", msg).strip() + "\n"

return msg.encode("utf-8")
EOF
)
else
  CALLBACK=$(cat <<'EOF'
import re
def callback(commit):
    msg = commit.message.decode("utf-8")

    msg = re.sub(
        r"(?im)^\s*Co-authored-by:\s+.+?<.+?>\s*$\n?",
        "",
        msg
    )

    msg = re.sub(r"\n{3,}", "\n\n", msg).strip() + "\n"

    commit.message = msg.encode("utf-8")
EOF
)
fi

#######################################
# EXECUTION
#######################################
if [ "$DRY_RUN" = true ]; then
  echo "🧪 DRY RUN MODE - no history will be rewritten"
  echo "Callback that would be used:"
  echo "----------------------------------------"
  echo "$CALLBACK"
  echo "----------------------------------------"
  exit 0
fi

echo "🚀 Rewriting history..."

git filter-repo \
  --message-callback "$CALLBACK" \
  --force

#######################################
# CLEANUP
#######################################
echo "🧹 Cleaning up..."

git reflog expire --expire=now --all
git gc --prune=now

#######################################
# DONE
#######################################
echo ""
echo "✅ Co-authored-by lines removed."
echo ""

echo "🔍 Verify:"
echo "  git log --format='%h %s%n%b' | less"

echo ""
echo "🚀 If everything looks good, push with:"
echo "  git push --force-with-lease --all"
echo "  git push --force-with-lease --tags"
echo ""

echo "⚠️ IMPORTANT:"
echo "  All collaborators must re-clone or reset their branches."
