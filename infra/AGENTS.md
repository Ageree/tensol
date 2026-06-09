# Purpose

`infra/` contains local and production infrastructure definitions: Docker
Compose, Caddy, deployment scripts, and Decepticon scanner override assets.

# Ownership

- Own `infra/docker`, `infra/prod`, and `infra/decepticon-overrides`.
- Production web/API posture must stay aligned with `docs/project-current-context.md`.

# Local Contracts

- Do not store secrets in infra files.
- Treat production deployment files as high-impact even when changes look small.
- Current production API is GCP-based; Timeweb and legacy Tensol production
  references are historical unless the task explicitly targets them.
- Keep Caddy/Docker changes compatible with the production API and scanner VM
  expectations.

# Work Guidance

- Validate Docker Compose and shell changes before claiming readiness when the
  relevant tooling is available.
- Prefer explicit env/config names over implicit defaults for production rails.

# Verification

- Compose edits: run the relevant `docker compose config` command when feasible.
- Shell/deploy edits: run syntax checks or dry-runs when safe, and report any
  production-only verification gap.

# Child DOX Index

No child Dox docs yet.
