<!-- dox:start -->
# DOX — AGENTS.md Documentation Framework

This project now uses `agent0ai/dox`: a self-documenting AGENTS.md hierarchy
for durable project context. Dox has no runtime, package, or dependency; the
contract is this AGENTS.md tree.

## Core Contract

- AGENTS.md files are binding work contracts for their directory subtrees.
- Before editing, read this root AGENTS.md and every child AGENTS.md on the
  path to each file you expect to touch.
- If a parent lists a child AGENTS.md whose scope contains the target path,
  read that child and continue from there.
- The nearest AGENTS.md owns local work details; parent docs own broader
  project rules. If docs conflict, the closer doc controls local details, but
  no child may weaken Dox, GitNexus, GitButler, security, or current-context
  rules.
- Do not rely on memory. Re-read the applicable Dox chain in the current
  session before editing.

## Update After Editing

- Every meaningful change requires a Dox pass before closeout.
- Update the closest owning AGENTS.md when a change affects purpose, scope,
  ownership, durable structure, contracts, workflows, verification, artifacts,
  permissions, constraints, side effects, or stable user preferences.
- Update parent docs when parent-level structure, ownership, workflow, or child
  index entries change.
- Small edits that do not change behavior or contracts may leave docs
  unchanged, but still report that the Dox pass found no doc update needed.
- Remove stale or contradictory instructions instead of adding historical
  explanations.

## Child Doc Shape

Use this section order for new child AGENTS.md files:

- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

Keep child docs concise, operational, and scoped to stable rules for that
subtree.

## Root Ownership

- Root owns repo-wide operating rules, source-control workflow, code-intel
  workflow, current product context, package-manager posture, and the top-level
  Dox index.
- Root owns root config/scripts and generated/runtime/cache/archive directories
  unless a more specific child AGENTS.md exists.
- Do not add Dox docs under generated or dependency directories such as
  `node_modules/`, `.git/`, `.gitnexus/`, `.omx/`, `coverage/`, or build
  outputs.

## User Preferences

- Use Dox for this project going forward.
- Keep the Dox tree current as the project structure, workflows, and local
  contracts change.

## Child DOX Index

- `apps/AGENTS.md` — frontend application workspace; delegates current site
  rules to `apps/site/AGENTS.md`.
- `server/AGENTS.md` — Bun/Hono API, jobs, reports, audit, auth, database, and
  production worker service.
- `convex/AGENTS.md` — Convex control-plane candidate, schema, functions, auth,
  and generated Convex API boundaries.
- `vps-agent/AGENTS.md` — ephemeral scan agent, callback protocol, evidence
  upload, Decepticon runner, and agent tests.
- `docs/AGENTS.md` — durable documentation, ADRs, runbooks, research, security
  notes, and current context.
- `infra/AGENTS.md` — Docker, production deployment files, Caddy, and scanner VM
  override assets.
- `specs/AGENTS.md` — feature specs, plans, contracts, task lists, and evidence
  records.

<!-- dox:end -->

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **пентест ИИ** (6146 symbols, 13053 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/пентест ИИ/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/пентест ИИ/context` | Codebase overview, check index freshness |
| `gitnexus://repo/пентест ИИ/clusters` | All functional areas |
| `gitnexus://repo/пентест ИИ/processes` | All execution flows |
| `gitnexus://repo/пентест ИИ/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

<!-- project-current-context:start -->
# Project Current Context

Before relying on older specs or runbooks, read
`docs/project-current-context.md`. Current defaults: international product
posture, current public brand **Sthrip**, current public domains
`sthrip.dev` / `api.sthrip.dev`, production API on GCP Compute Engine
(`tensol-scanners`, VM `sthrip-api-prod`, zone `europe-west1-b`, static IP
`34.156.105.67`), Clerk auth target, provider-agnostic billing, Convex as the
likely future control plane, and no new YooKassa/RUB/RU-first or GCP
production assumptions. Legacy **Tensol** / `tensol.ru`, Timeweb, and GCP
references are historical or compatibility-only unless a task is explicitly
about that legacy context.

<!-- project-current-context:end -->

<!-- gitbutler:start -->
# GitButler — Virtual Branch Workflow

This repo is GitButler-managed in its **cockpit checkout** — the `gitbutler/workspace` working dir where `but status` exits 0. There, virtual branches are LIVE and you use the **`but`** CLI for **all git writes**; plain `git` writes bypass GitButler's routing and can corrupt the workspace.

## FIRST: which context am I in? — cockpit vs worktree

Run `git rev-parse --show-toplevel` + `but status`:
- **Cockpit checkout** — toplevel is the main repo dir AND `but status` exits 0 → GitButler is LIVE. Follow the `but`-for-writes rules below.
- **Git worktree** — toplevel is a *linked worktree* (a sibling `<repo>.<agent>-<task>` dir, or under `.claude/worktrees/`, created by `wt` / `git worktree add`) → it is **NOT** a GitButler workspace. Use **plain git** (`git add` / `git commit` / `git push`) on a feature branch → PR to `main`. **Never run `but` in a worktree** (even though it shares `.git`).

> **Why two contexts:** parallel multi-agent work (Claude + Codex, many simultaneous sessions) is isolated with **one git worktree per session** — that is the unit that stops two agents clobbering one tree. GitButler is the single hand-driven cockpit, not the multi-agent coordinator. Full model: `~/Documents/multi-harness-power-user-guide.md`; spawn a worktree with `wt <task> --agent claude|codex`.

> **Ground-truth check, every time.** Before relying on the `but` rules, run `but status` — exit 0 in the cockpit means GitButler is active. If it fails (fresh clone, `but` not installed, `but setup` never run) **or you are in a worktree**, use plain `git` and do NOT invoke `but`. This section + any committed `.claude/skills/gitbutler/` folder signal INTENT, not active state — the runtime probe is the only proof.

## Always Do (writes → `but`, never `git`)

- **Commit:** `but commit -m "<type>: <desc>"`. With one branch applied it commits there; with several applied, name the branch: `but commit <branch> -m "…"`. Use `--only` to commit just what is staged to that branch.
- **New branch:** `but branch new <name>` — creates a virtual branch in the workspace (not `git checkout -b`).
- **Stage a specific hunk/file:** `but stage <id>`, where `<id>` is the short 2–3 char ID from `but status --json`.
- **Push / open review:** `but push`, then `but pr create` for a forge PR. Never `git push`.
- **Edit existing commits:** `but amend`, `but absorb`, `but squash`, `but reword`, `but uncommit` — interactive rebase (`git rebase -i`) is unsupported in this harness and bypasses GitButler regardless.
- **Read workspace state + the short IDs** via `but status --json`; pass those IDs to `but` commands.

## Reads stay on plain `git` (GitButler is git-compatible)

`git log`, `git diff`, `git blame`, `git show` are all safe — they don't mutate the workspace. Prefer them for inspection.

## Never Do

- NEVER use `git add`, `git commit`, `git push`, `git checkout -b`, `git branch <name>`, `git merge`, or `git rebase` for writes here — they bypass virtual branches. Use the `but` equivalents (`but stage`, `but commit`, `but push`, `but branch new`, `but merge`).
- NEVER spontaneously create a worktree / `EnterWorktree` to escape the **cockpit** mid-task — that forks the branch off the workspace and drops GitButler-routed commits. (Deliberate parallel isolation is the opposite and is encouraged: the sanctioned flow is `wt <task>` → work in that worktree with **plain git** → PR to `main`; inside such a worktree the `but` rules above do NOT apply.)
- NEVER classify GitButler as inactive from file presence alone — probe with `but status`.

## Gotcha — hunk locked to a parallel branch

A hunk in a file already rewritten by branch A **cannot** be committed to a parallel branch B. GitButler locks the hunk to A; `but commit B --only` silently prints "Some selected changes could not be committed" and creates an empty "(no changes)" commit, leaving the file staged-but-uncommitted. Fix: amend it into A's commit — `but amend <cliId> <commitOfA>` (take `<cliId>` from `but status --json`, NOT the file path — `but amend <path>` errors "Source not found" for already-assigned files) — or stack B on top of A.

## Pre-commit checklist (combine with the GitNexus checklist above)

1. `gitnexus_detect_changes()` — confirm changes match the expected scope.
2. `but status --json` — review unassigned vs branch-routed changes and grab the short IDs.
3. `but commit -m "<type>: <desc>"` — conventional-commit format (feat, fix, refactor, docs, test, chore, perf, ci).
4. `but push` (+ `but pr create`) only when the user asks to push or open a PR.

## Reference

- Official agent-workflow skill: `~/.claude/skills/gitbutler-claude/SKILL.md` (its `setup-project.sh` (re)installs the `but` hooks + the canonical `but` agent skill).
- Full CLI surface: `but --help` and `but <command> --help`. Docs: https://docs.gitbutler.com/cli-overview
<!-- gitbutler:end -->

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
