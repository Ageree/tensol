#!/usr/bin/env bash
# T143: scan committed tree for secret-shaped strings outside known-fixture paths.
# Patterns covered: Anthropic, OpenRouter, OpenAI proj, Stripe live/test, AWS Access Key.
# Allow-list paths (intentional synthetic patterns):
#   - test files (*.test.ts, tests/, test/)
#   - fixtures/
#   - specs/ docs/ README*
#   - e2e/helpers/
#   - server/src/deep-inquiries/sanitize.ts (redaction regex source)
#   - scripts/extract-claude-creds.sh (OAuth token shape validator)
#
# Exit 0 → clean. Exit 1 → real-secret leak found (prints offending paths).
set -euo pipefail

PATTERN='sk-ant-|sk-or-|sk-proj-|sk_live_|sk_test_|AKIA[A-Z0-9]{16}'

# Restrict scan to committed files only (ignored + untracked are out of scope).
RAW_HITS=$(git grep -nE "$PATTERN" -- $(git ls-files) 2>/dev/null || true)

# Filter allow-listed paths. We match path-segments, *.test.* suffix,
# and two explicit file allowances (sanitize regex + OAuth extractor).
HITS=$(echo "$RAW_HITS" | grep -vE '/(tests?|fixtures|specs|docs|e2e/helpers)/|^(tests?|fixtures|specs|docs)/|\.test\.(ts|tsx|js)$|\.test\.(ts|tsx|js):|/README|^README|sanitize\.ts:|extract-claude-creds\.sh:' || true)

# Drop empty result lines that `grep -v` may emit.
HITS=$(echo "$HITS" | sed '/^$/d')

if [ -n "$HITS" ]; then
  echo "ERROR: secret-shaped strings found in non-fixture paths:"
  echo "$HITS"
  exit 1
fi

echo "OK: no secrets in committed tree (outside fixtures/docs/tests)"
