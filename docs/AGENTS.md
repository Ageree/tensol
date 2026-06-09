# Purpose

`docs/` contains durable project context: current product posture, ADRs,
runbooks, research, security mappings, design notes, and planning artifacts.

# Ownership

- Own current context docs, operator runbooks, ADRs, research dossiers, security
  notes, and durable design/planning references.
- `docs/project-current-context.md` is the first read for current Sthrip brand,
  domains, production posture, auth, billing, backend direction, and deployment
  assumptions.

# Local Contracts

- New docs should default to the current Sthrip/international posture unless
  explicitly documenting legacy evidence.
- Do not introduce new YooKassa/RUB/RU-first, Timeweb, or legacy Tensol
  production assumptions as current facts.
- Never commit secrets or operational credentials to docs.
- Historical docs may preserve historical facts, but new guidance must clearly
  distinguish current vs legacy context.

# Work Guidance

- Keep docs concise, dated when time-sensitive, and operational.
- Prefer updating stale guidance over adding contradictory notes.
- Link to authoritative specs/runbooks instead of duplicating large blocks.

# Verification

- Markdown-only changes usually have no automated check. Verify links/paths and
  factual consistency with `docs/project-current-context.md`.

# Child DOX Index

No child Dox docs yet.
