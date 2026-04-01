#!/bin/bash
# Git post-commit hook - runs AI review on committed files in background
# Writes live logs to logs/latest.log (tail -f logs/latest.log to follow)
# Install: cp scripts/post-commit.sh .git/hooks/post-commit && chmod +x .git/hooks/post-commit

NODE_PATH="${APPDATA}/nvm/v22.11.0/node.exe"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve repo root
if [[ "$SCRIPT_DIR" == *".git/hooks"* ]]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

RUNNER="$REPO_DIR/scripts/post-commit-review.mjs"
COMMIT_HASH=$(git rev-parse HEAD)
SHORT_HASH=$(git rev-parse --short HEAD)

echo "=== Post-commit: Starting AI review for $SHORT_HASH in background ==="
echo "=== Follow live: tail -f $REPO_DIR/logs/latest.log ==="

# Run review in background so commit doesn't block
"$NODE_PATH" "$RUNNER" "$COMMIT_HASH" &

exit 0
