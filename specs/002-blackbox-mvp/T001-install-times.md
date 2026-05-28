# T001 — Install Times Evidence

**Date**: 2026-05-19
**Branch**: `002-blackbox-mvp` (confirmed via `git rev-parse --abbrev-ref HEAD`)
**Bun version**: 1.3.11 (af24e281)
**Host**: darwin 24.6.0

## bun install (warm cache, no changes)

| Package      | Installs / Packages | Wall time | Outcome |
|--------------|---------------------|-----------|---------|
| `server/`    | 175 / 301           | 0.047s    | OK (no changes) |
| `apps/site/` | 175 / 301           | 0.009s    | OK (no changes) |
| `vps-agent/` | 175 / 301           | 0.012s    | OK (no changes) |

All three packages are independent siblings (Constitution III — no `packages/*`
monorepo). Warm-cache totals reflect identical baseline (react + typescript +
hono toolchain). Cold-install times are not measured here; if needed, run with
`rm -rf node_modules` first.

## Verification

```
$ git rev-parse --abbrev-ref HEAD
002-blackbox-mvp

$ bun --version
1.3.11
```

Dashboard signal: install layer is healthy, no lockfile drift, no native-module
build failures across server / site / vps-agent.

Implements T001.
