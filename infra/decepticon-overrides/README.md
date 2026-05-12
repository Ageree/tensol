# Decepticon Overrides

Tensol-side patches applied on top of the vendored Decepticon clone at `../external/decepticon/`.

## Why these exist

Decepticon ships as Apache-2.0 source under `external/decepticon/` (cloned, not a submodule). Tensol customizes a small surface for product integration:

- **`recon.md`** — adds Rule 4b (`KG_PERSISTENCE`) so Decepticon's `recon` agent writes each `findings/FIND-{NNN}.md` ALSO into the Neo4j knowledge graph as a `vulnerability` node. Required so Decepticon's `verifier` agent (which reads ONLY the kg, not markdown) can pick up findings for Zero-False-Positive validation. Without this override, recon's findings stay file-only, invisible to verifier, and Tensol cannot ship validated `findings` (only `candidate_findings`).

- **`docker-compose.override.yml`** — mounts the override `recon.md` into the running `decepticon-langgraph` container at `/app/decepticon/agents/prompts/recon.md`. Without this mount, the baked-in upstream prompt wins and Rule 4b is ignored.

## How to apply

From the repo root:

```bash
./infra/decepticon-overrides/apply.sh
```

The script copies the override files into `external/decepticon/` and force-recreates `decepticon-langgraph` so the new mount takes effect.

After running, verify the override is live inside the container:

```bash
docker exec decepticon-langgraph grep -c "TENSOL OVERRIDE" /app/decepticon/agents/prompts/recon.md
# Expected output: 1
```

## When upstream Decepticon updates

If you `git -C external/decepticon pull origin main` and our overrides conflict (recon.md upstream changed), resolve manually:

1. Read upstream's new `recon.md`
2. Re-apply Rule 4b semantics into the new structure
3. Update `infra/decepticon-overrides/recon.md` here as the new source of truth
4. Re-run `apply.sh`

## Audit trail

- Override created: 2026-05-12 (Phase 3.1, `project_tensol_phase3_verifier_audit_2026-05-12.md`)
- Targeted Decepticon upstream commit: `004f3c7`
