#!/usr/bin/env bash
# Extract Claude Code OAuth credentials from macOS Keychain into a JSON
# file that Decepticon's litellm container can bind-mount.
#
# On many macOS installs the file at ~/.claude/.credentials.json is missing
# or is an empty directory — the canonical store is the keychain entry
# "Claude Code-credentials". Decepticon's claude_code_handler.py reads a
# file at $CLAUDE_CODE_CREDENTIALS_PATH (default ~/.claude/.credentials.json).
# This script materializes that file on demand without touching the
# original keychain entry.
#
# Usage:
#   scripts/extract-claude-creds.sh [out-path]
#
# Default out-path: ~/.claude/.credentials.json (file). If a directory
# already exists there, the script aborts unless --force is passed.
#
# Exit codes:
#   0 — file written successfully and shape validated
#   1 — keychain entry missing or empty
#   2 — output target is a directory and --force not given
#   3 — JSON parse failed or token shape invalid
set -euo pipefail

FORCE=0
OUT="${HOME}/.claude/.credentials.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *)
      OUT="$1"; shift
      ;;
  esac
done

KEYCHAIN_SERVICE="Claude Code-credentials"

# Pull the raw secret. -w prints the password value to stdout.
RAW="$(security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null || true)"
if [[ -z "${RAW}" ]]; then
  echo "error: keychain entry '${KEYCHAIN_SERVICE}' not found or empty" >&2
  echo "       try: claude /login    (and approve the OAuth flow in browser)" >&2
  exit 1
fi

# Validate shape before touching the filesystem.
TOKEN_PREFIX="$(printf '%s' "${RAW}" | python3 -c 'import json,sys
d=json.load(sys.stdin)
oauth=d.get("claudeAiOauth",{})
tok=oauth.get("accessToken") or d.get("accessToken") or d.get("oauthToken") or ""
if not isinstance(tok,str) or not tok.startswith("sk-ant-oat01-"):
    sys.exit("token shape invalid (expected accessToken sk-ant-oat01-…)")
print(tok[:18])' 2>&1)" || {
  echo "error: invalid JSON or token shape in keychain entry" >&2
  echo "       keychain returned: $(printf '%.40s…' "${RAW}")" >&2
  exit 3
}

# Handle existing target.
if [[ -e "${OUT}" || -L "${OUT}" ]]; then
  if [[ -d "${OUT}" ]]; then
    if [[ "${FORCE}" -ne 1 ]]; then
      echo "error: '${OUT}' exists as a directory; pass --force to remove it" >&2
      exit 2
    fi
    rmdir "${OUT}" 2>/dev/null || rm -rf "${OUT}"
  elif [[ -f "${OUT}" && "${FORCE}" -ne 1 ]]; then
    # Refresh in place — keep idempotency.
    :
  fi
fi

mkdir -p "$(dirname "${OUT}")"

# Atomic write with 0600 perms.
TMP="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "${TMP}"' EXIT
printf '%s\n' "${RAW}" > "${TMP}"
chmod 0600 "${TMP}"
mv -f "${TMP}" "${OUT}"
trap - EXIT

# Final shape check on the written file.
python3 -c "import json; json.load(open('${OUT}'))" >/dev/null

echo "wrote ${OUT}"
echo "token prefix: ${TOKEN_PREFIX}…  (sk-ant-oat01-, OAuth)"
echo "perms: $(stat -f '%Sp' "${OUT}")"
