# Purpose

`apps/` contains user-facing applications. The current durable app is
`apps/site`, the Sthrip Vite/React web app.

# Ownership

- Own app-level workspace structure and cross-app conventions.
- Delegate concrete Sthrip site rules to `apps/site/AGENTS.md`.

# Local Contracts

- Follow the root Dox chain before editing any app file.
- Keep app work aligned with `docs/project-current-context.md`: current public
  brand is Sthrip and current public domains are `sthrip.dev` /
  `api.sthrip.dev`.
- Do not introduce new app packages or frameworks without an explicit user
  request.

# Work Guidance

- Prefer existing app patterns and local helpers over new abstractions.
- Keep generated build outputs out of source edits unless the user explicitly
  asks for artifact changes.

# Verification

- Use the nearest app's own verification commands. For `apps/site`, read
  `apps/site/AGENTS.md`.

# Child DOX Index

- `site/AGENTS.md` — Sthrip public site and authenticated dashboard app.
