<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **пентест ИИ** (5524 symbols, 11581 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:

- Plan: `specs/004-sthrip-pr-review/plan.md`
- Spec: `specs/004-sthrip-pr-review/spec.md`
- Research: `specs/004-sthrip-pr-review/research.md`
- Data model: `specs/004-sthrip-pr-review/data-model.md`
- API contract: `specs/004-sthrip-pr-review/contracts/openapi.yaml`
- Webhook contract: `specs/004-sthrip-pr-review/contracts/webhooks.md`
- Quickstart: `specs/004-sthrip-pr-review/quickstart.md`
- Constitution: `.specify/memory/constitution.md` (v1.0.0)

Prior features (still on disk, NOT active scope):
- 001-backend-v2 plan: `specs/001-backend-v2/plan.md`
- 002-blackbox-mvp plan: `specs/002-blackbox-mvp/plan.md`
- 003-whitebox plan: `specs/003-whitebox/plan.md`
<!-- SPECKIT END -->
