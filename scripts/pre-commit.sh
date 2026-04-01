#!/bin/bash
# Git pre-commit hook - runs orchestrate_review on staged code files
# Install: cp scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

NODE_PATH="${APPDATA}/nvm/v22.11.0/node.exe"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# If running from .git/hooks, resolve to repo root
if [[ "$SCRIPT_DIR" == *".git/hooks"* ]]; then
  REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

RUNNER="$REPO_DIR/scripts/review-runner.mjs"

# Get staged files (only added/modified, not deleted)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

echo "=== Pre-commit: Running AI review pipeline ==="
FAILED=0

for FILE in $STAGED_FILES; do
  # Skip non-code files
  case "$FILE" in
    *.js|*.mjs|*.ts|*.tsx|*.py|*.cs|*.go|*.rs|*.java|*.rb|*.php|*.cpp|*.c)
      echo "Reviewing: $FILE"
      "$NODE_PATH" "$RUNNER" "$REPO_DIR/$FILE" 2>&1
      EXIT_CODE=$?
      if [ $EXIT_CODE -eq 2 ]; then
        echo "BLOCKED: Critical issues in $FILE"
        FAILED=1
      elif [ $EXIT_CODE -ne 0 ]; then
        echo "WARNING: Review error for $FILE (continuing)"
      fi
      ;;
    *)
      ;;
  esac
done

if [ $FAILED -ne 0 ]; then
  echo ""
  echo "=== COMMIT BLOCKED: Critical issues found ==="
  echo "Fix the issues above and try again."
  exit 1
fi

echo "=== Pre-commit: All reviews passed ==="
exit 0
