# Purpose

`specs/` contains feature specs, implementation plans, data models, OpenAPI and
webhook contracts, task lists, checklists, and verification evidence.

# Ownership

- Own durable feature-scoped planning and contract artifacts.
- Specs can contain historical evidence; do not treat older specs as current
  production truth when they conflict with `docs/project-current-context.md`.

# Local Contracts

- Keep specs internally consistent: if changing contracts or tasks, update the
  neighboring plan/data-model/checklist evidence when applicable.
- Current product posture is Sthrip-first and international by default.
- Preserve historical evidence files unless the task explicitly asks to rewrite
  or supersede them.

# Work Guidance

- Prefer small updates near the relevant feature folder over broad cross-spec
  rewrites.
- Make current-vs-legacy status explicit when editing older Tensol-era specs.

# Verification

- Contract edits should be checked against the implementation and tests that
  consume them.
- Markdown-only planning edits usually have no automated check; verify paths and
  references manually.

# Child DOX Index

No child Dox docs yet.
