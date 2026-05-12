#!/usr/bin/env bash
# Apply Tensol overrides on top of the vendored Decepticon clone.
# Source of truth: infra/decepticon-overrides/. This script copies them
# into external/decepticon/ and force-recreates the langgraph container
# so the new prompt + volume mount take effect.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="${REPO_ROOT}/infra/decepticon-overrides"
DST="${REPO_ROOT}/external/decepticon"

if [[ ! -d "${DST}" ]]; then
  echo "FATAL: ${DST} not found. Clone Decepticon first:"
  echo "  git clone https://github.com/PurpleAILAB/Decepticon ${DST}"
  exit 1
fi

echo "==> Copying recon.md override"
cp "${SRC}/recon.md" "${DST}/decepticon/agents/prompts/recon.md"

echo "==> Copying docker-compose.override.yml"
cp "${SRC}/docker-compose.override.yml" "${DST}/docker-compose.override.yml"

echo "==> Force-recreating decepticon-langgraph (picks up new mount)"
cd "${DST}"
docker compose up -d --force-recreate --no-deps langgraph

echo "==> Waiting for healthy (max 5min)..."
for i in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' decepticon-langgraph 2>/dev/null || echo "missing")
  if [[ "${status}" == "healthy" ]]; then
    echo "==> langgraph healthy after ${i} polls (~$((i * 5))s)"
    break
  fi
  if [[ ${i} -eq 60 ]]; then
    echo "FATAL: langgraph did not become healthy within 5min"
    exit 1
  fi
  sleep 5
done

echo "==> Verifying override is live inside container"
count=$(docker exec decepticon-langgraph grep -c "TENSOL OVERRIDE" /app/decepticon/agents/prompts/recon.md || echo 0)
if [[ "${count}" == "1" ]]; then
  echo "==> SUCCESS: Rule 4b KG_PERSISTENCE is live"
else
  echo "FATAL: TENSOL OVERRIDE marker not found inside container (count=${count})"
  exit 1
fi
