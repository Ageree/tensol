#!/usr/bin/env bash
# server/scripts/license-audit.sh
#
# License-compliance audit for the shippable server/ path.
# Enforces FR-028: no AGPL/BSL/SSPL/Elastic/Commons-Clause/PolyForm-NC
# in the shippable runtime.
#
# Checks:
#   (a) No "gitnexus" import/reference under server/src — PolyForm-NC, commercial-SaaS-unsafe.
#   (b) If STHRIP_OPENGREP_RULES_DIR is set and the dir exists:
#       - Assert it is NOT the upstream opengrep/opengrep-rules repo (Commons Clause).
#       - Assert it is NOT a semgrep registry checkout (SRL-1.0).
#       - Assert a LICENSE file is present and does NOT contain forbidden terms.
#   (c) Scan server/package.json (and any nested package.json in server/) for
#       known-bad packages by name.
#
# Exit 0 → clean. Exit non-zero → violation (prints details).
#
# CI wiring: T051 (a later task) will add this as a step in the CI pipeline.
# For now, run manually: bash server/scripts/license-audit.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root is two levels up from server/scripts/
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_SRC="$REPO_ROOT/server/src"

VIOLATIONS=0

fail() {
  echo "LICENSE VIOLATION: $*" >&2
  VIOLATIONS=$((VIOLATIONS + 1))
}

info() {
  echo "license-audit: $*"
}

# ---------------------------------------------------------------------------
# (a) No gitnexus in server/src
#     Rationale: GitNexus is PolyForm-Noncommercial-1.0.0 → cannot ship in a
#     paid SaaS. It is agent-time tooling only; research.md §R1 confirms it was
#     never imported by the product, and this check enforces that boundary going
#     forward.
# ---------------------------------------------------------------------------
info "Checking server/src for 'gitnexus' imports..."

if [ ! -d "$SERVER_SRC" ]; then
  fail "server/src directory not found at $SERVER_SRC"
else
  GITNEXUS_HITS=$(grep -rl --include="*.ts" --include="*.js" --include="*.json" \
    "gitnexus" "$SERVER_SRC" 2>/dev/null || true)
  if [ -n "$GITNEXUS_HITS" ]; then
    fail "'gitnexus' reference found in server/src (PolyForm-NC — must never ship):"
    echo "$GITNEXUS_HITS" | sed 's/^/  /' >&2
  else
    info "OK — no gitnexus references in server/src"
  fi
fi

# ---------------------------------------------------------------------------
# (b) Opengrep rules-dir check (only when STHRIP_OPENGREP_RULES_DIR is set)
#     Rationale: opengrep/opengrep-rules carries LGPL-2.1 + Commons Clause
#     ("no Sell"). Semgrep registry rules are SRL-1.0 (no competing SaaS).
#     Both are forbidden. Permitted sources: AikidoSec/opengrep-rules (MIT)
#     or self-authored rules.
# ---------------------------------------------------------------------------
RULES_DIR="${STHRIP_OPENGREP_RULES_DIR:-}"

if [ -n "$RULES_DIR" ]; then
  info "Checking STHRIP_OPENGREP_RULES_DIR: $RULES_DIR"

  if [ ! -d "$RULES_DIR" ]; then
    fail "STHRIP_OPENGREP_RULES_DIR is set but directory does not exist: $RULES_DIR"
  else
    # (b1) Path-name check: disallow well-known forbidden upstream checkouts.
    # Match the EXACT upstream repo names as path components:
    #   - /opengrep/opengrep-rules  (Commons Clause)
    #   - /semgrep/semgrep-rules or /semgrep-rules (SRL-1.0)
    # Pattern anchors to a path separator so "aikido-opengrep-rules" does NOT match.
    RULES_REALPATH="$(cd "$RULES_DIR" && pwd)"
    if echo "$RULES_REALPATH" | grep -qiE "/opengrep/opengrep-rules(/|$)|/semgrep/semgrep-rules(/|$)|/semgrep-rules(/|$)"; then
      fail "STHRIP_OPENGREP_RULES_DIR path '$RULES_REALPATH' looks like a forbidden upstream rules repo (Commons Clause or SRL-1.0)"
    fi

    # (b2) LICENSE file must exist (self-authored / AikidoSec MIT should always have one)
    if [ ! -f "$RULES_DIR/LICENSE" ] && [ ! -f "$RULES_DIR/LICENSE.md" ] && [ ! -f "$RULES_DIR/LICENSE.txt" ]; then
      fail "STHRIP_OPENGREP_RULES_DIR has no LICENSE file — cannot verify it is permissive (MIT/Apache-2.0/self-authored)"
    else
      # (b3) LICENSE content must not contain Commons Clause or SRL markers
      LICENSE_FILE=""
      for candidate in "$RULES_DIR/LICENSE" "$RULES_DIR/LICENSE.md" "$RULES_DIR/LICENSE.txt"; do
        if [ -f "$candidate" ]; then
          LICENSE_FILE="$candidate"
          break
        fi
      done

      if grep -qiE "Commons Clause|SRL-1\.0|Semgrep Rules License|opengrep-rules" "$LICENSE_FILE" 2>/dev/null; then
        fail "LICENSE at '$LICENSE_FILE' contains forbidden terms (Commons Clause / SRL-1.0)"
      else
        info "OK — rules dir LICENSE appears permissive"
      fi
    fi

    # (b4) Check for a .git/config that reveals the remote (belt-and-suspenders)
    GIT_CONFIG="$RULES_DIR/.git/config"
    if [ -f "$GIT_CONFIG" ]; then
      if grep -qiE "opengrep/opengrep-rules|semgrep/semgrep-rules" "$GIT_CONFIG" 2>/dev/null; then
        fail "Rules dir .git/config reveals forbidden upstream: $(grep -iE 'opengrep/opengrep-rules|semgrep/semgrep-rules' "$GIT_CONFIG")"
      fi
    fi

    info "OK — STHRIP_OPENGREP_RULES_DIR passed all checks"
  fi
else
  info "STHRIP_OPENGREP_RULES_DIR not set — skipping rules-dir check"
fi

# ---------------------------------------------------------------------------
# (c) Known-bad packages in server/package.json (and any nested package.json)
#     Rationale: the shippable path must not npm-link any of these regardless
#     of how they ended up in package.json (direct or transitive dev deps that
#     accidentally become runtime deps).
#
#     FORBIDDEN packages (by npm name pattern):
#       @gitbutler/*             — PolyForm-NC commercial restriction
#       gitnexus                 — PolyForm-NC
#       @polyform-nc/*           — PolyForm-NC family
#       trufflehog               — AGPL-3.0 (replace with Kingfisher)
#       bearer                   — Elastic License 2.0 (no hosted service)
#       @bearer/*                — Elastic License 2.0
#       codeql / @github/codeql  — proprietary engine
#       semgrep                  — rules SRL-1.0 (engine LGPL is fine as sidecar;
#                                   but having it as an npm dep is a smell)
#       vulnhuntr                — AGPL-3.0
#       @code-security/*         — known AGPL
#       qlty-cli / @qlty/*       — BSL-1.1
#       kodus / @kodus/*         — AGPL-3.0
# ---------------------------------------------------------------------------
info "Checking package.json files under server/ for known-bad license deps..."

# Collect all package.json files under server/ (excluding node_modules)
PKGJSON_FILES=$(find "$REPO_ROOT/server" -name "package.json" \
  -not -path "*/node_modules/*" 2>/dev/null || true)

FORBIDDEN_PATTERN='("gitnexus"|"@gitbutler/|"trufflehog"|"bearer"|"@bearer/|"codeql"|"@github/codeql|"semgrep"|"vulnhuntr"|"@code-security/|"qlty-cli"|"@qlty/|"kodus"|"@kodus/|"@polyform-nc/)'

PKGJSON_VIOLATIONS=""
for pkgfile in $PKGJSON_FILES; do
  HITS=$(grep -nE "$FORBIDDEN_PATTERN" "$pkgfile" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    PKGJSON_VIOLATIONS="$PKGJSON_VIOLATIONS\n  $pkgfile:\n$(echo "$HITS" | sed 's/^/    /')"
  fi
done

if [ -n "$PKGJSON_VIOLATIONS" ]; then
  fail "Known-bad license packages found in package.json (AGPL/BSL/ELv2/PolyForm-NC/Commons-Clause/proprietary):"
  echo -e "$PKGJSON_VIOLATIONS" >&2
else
  info "OK — no known-bad license packages in server/package.json"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$VIOLATIONS" -eq 0 ]; then
  echo "license-audit: ALL CHECKS PASSED — shippable path is license-clean."
  exit 0
else
  echo "license-audit: $VIOLATIONS VIOLATION(S) FOUND — see errors above." >&2
  exit 1
fi
