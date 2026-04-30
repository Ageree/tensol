# ADR 0007 — Browser Agent Driver: Semantic Action Layer for Autonomous Pentest

- **Status:** Accepted (with deviation — see Outcome section)
- **Supersedes:** N/A
- **Superseded by:** N/A
- **Tags:** browser-automation, stagehand, playwright, llm-agent, s15-auth, s16-spa-discovery

---

## Context

### Current state

`services/browser-worker/` drives Chromium via a `BrowserDriver` interface
(`launch / navigate / close`). The implementation shipped in Sprint 9 is a
stub (`RealBrowserDriver`) that rejects every call with `NotImplementedError`.
The existing `FakeBrowserDriver` is used for all tests.

The production path (`BROWSER_DRIVER=real`) needs to be filled before Sprint
15 (recipe-driven login) and Sprint 16 (SPA route discovery). Both sprints
require actions that raw `chromium.launch()` Playwright handles at the
selector level — but the coordinating AI agent needs to express intent in
natural language ("click the login button", "fill username field") rather than
hard-coded CSS selectors, which break on every target application.

### Why a semantic action layer

A bare Playwright driver forces the LLM to produce fragile CSS selectors or
XPath expressions for every target. The selector changes when the target app
updates its front end, making the pentest agent brittle. The industry response
(reflected in XBOW's architecture, though not publicly documented) is a
semantic action API: the agent states *what* to do; the driver figures out
*how* using the live accessibility tree.

Sprint 15 adds `storageState`-backed auth sessions and recipe-driven login
sequences (click → fill → submit). Sprint 16 adds `History.pushState`
observer injection for SPA route discovery. Both capabilities must coexist in
the same driver process; they are not separable into a Python sidecar or a
remote cloud service.

### Hard constraints

| Constraint | Rationale |
|------------|-----------|
| Bun 1.3.x runtime | Project-wide monorepo standard |
| No Python service | Single-process TS worker; no cross-language IPC |
| No heavy infra | No Redis/Kafka/k8s added for the driver alone |
| `storageState` + recipe auth (S15) | Must support Playwright-style session files |
| `History.pushState` injection (S16) | Must allow `page.evaluate()` / CDP `Runtime.evaluate` |
| License: MIT or Apache-2.0 | Commercial product; AGPL is a blocker |

---

## Options Compared

### Option A — `@browserbasehq/stagehand` v3.x (CDP-native, MIT)

**What it is.** Stagehand is an AI-native browser automation SDK. v1–v2 sat on
top of Playwright; v3 (released 2026-04-27, npm `3.3.0`) was rewritten to talk
CDP directly, dropping Playwright as a hard dependency and making it optional.
The semantic API surface is three primitives:

```
stagehand.act("click the login button")       // semantic click / type / select
stagehand.observe("find the username field")  // returns element descriptors
stagehand.extract({ ... })                    // structured data via Zod schema
```

There is also a higher-level `stagehand.agent()` for multi-step tasks.

**Dependencies footprint.** Core runtime deps: `ai` (Vercel AI SDK), `ws`,
`pino`, `uuid`, `openai`, `@anthropic-ai/sdk`, `devtools-protocol`,
`@browserbasehq/sdk`, `@modelcontextprotocol/sdk`. Playwright is
*optional* — included only if you want the Playwright driver; otherwise
`chrome-launcher` + raw CDP suffices. This means the package is pure
JS/TS with no native binary of its own beyond whatever browser binary you
point it at.

**Hosting model.** Local-first: launches a local Chromium or connects to any
CDP endpoint. Optional cloud execution via Browserbase (paid SaaS), but the
SDK works fully offline.

**Bun compatibility.** v3's CDP-native architecture explicitly achieves "full
portability across environments (including Bun)" per the release blog. The
prior Bun blocker was Playwright's internal use of Node APIs; v3 bypasses
Playwright's test-runner layer entirely.

**storageState + recipe auth (S15).** CDP-native, so we can restore a session
by injecting cookies directly via `Network.setCookies` and `Storage.setCookies`
or by pointing at a Chrome profile directory. Can wrap existing
Playwright-format `storageState.json` via the optional `playwright-core`
adapter.

**History.pushState injection (S16).** `stagehand.page.evaluate(...)` /
`stagehand.page.exposeFunction(...)` are available in the CDP layer. The
observer can be injected at page init via a CDP `Page.addScriptToEvaluateOnNewDocument` call.

**Last release.** `3.3.0` on 2026-04-27. Active weekly cadence.

**License.** MIT.

**Cost.** Zero for local CDP usage; Browserbase cloud is paid (but optional
and not required).

**Cons.** v3 is weeks old (cutting edge); the CDP layer has less community
mileage than Playwright's robust actionability checks. The `engines` field
requires Node >=20.19.0 or >=22.12.0 — Bun satisfies this in compatibility
mode (Bun 1.3.x reports Node 22 compatibility). Dependency tree is large:
brings in multiple AI SDK provider packages as optional deps. Must audit which
optional deps we actually install.

---

### Option B — `@playwright/mcp` v0.0.71 (MCP server, Apache-2.0)

**What it is.** Microsoft's official Playwright MCP server. Exposes 60+ tools
(navigation, click, fill, screenshot, network mock, storage, tracing) over the
MCP protocol (stdio or HTTP/SSE transport).

**Action API.** Tool-call based, not a programmatic library API. An LLM sends
`{"tool": "browser_click", "params": {"element": "Login button"}}` via MCP
protocol. The server resolves the element from the live accessibility tree and
clicks it. No code-level `page.act()` — the boundary is a JSON RPC hop.

**Dependency footprint.** Runtime: `playwright@1.60.0-alpha` + `playwright-core`.
No additional AI SDK. Very lean.

**Hosting model.** Out-of-process MCP server (stdio child process or HTTP
server). The browser-worker would spawn it as a subprocess or connect to it
over HTTP. This adds IPC overhead and a process lifecycle to manage.

**Bun compatibility.** Playwright itself runs on Bun in Node-compat mode.
`@playwright/mcp` is a Node.js CLI (`bin: playwright-mcp`). Bun can `bun run
playwright-mcp` as a subprocess. However the `engines` field is `node >=18`,
which Bun 1.3 satisfies.

**storageState (S15).** Full Playwright `storageState` support — it is Playwright
underneath.

**History.pushState injection (S16).** Possible via `browser_evaluate` tool
call over MCP, but requires round-tripping through the MCP protocol JSON for
every inject call. Works; not ergonomic.

**Last release.** `0.0.71` on 2026-04-30. Active daily cadence (alpha track).

**License.** Apache-2.0.

**Cost.** Zero; fully local.

**Cons.** Pre-1.0 / alpha quality. Primary design target is Claude Desktop and
VS Code Copilot — not embedding in a worker service. Using it as a programmatic
library inside the worker is awkward: the "programmatic" path still starts an
MCP server and connects to it over stdio/HTTP within the same process. Every
semantic action adds serialization + IPC round-trip latency. The version scheme
(0.0.x) signals API instability. Hardest to integrate cleanly into the existing
`BrowserDriver` interface without a significant adapter shim.

---

### Option C — `steel-sdk` + `steel-browser` (remote browser-as-a-service, Apache-2.0)

**What it is.** Steel is an open-source browser-as-a-service platform. The
`steel-browser` repo is a Docker-packaged Chromium with a REST API and
Playwright/Puppeteer/Selenium session management. The `steel-sdk` TypeScript
package communicates with that server.

**Action API.** REST: `/scrape`, `/screenshot`, `/pdf`, plus Playwright sessions
connected to the remote browser over CDP. No built-in semantic LLM action
primitives — you get a remote Playwright page and drive it yourself.

**Dependency footprint.** `steel-sdk@0.18.0` is a thin REST client. The heavy
part is the Docker image (Chrome + Node server). Requires Docker or a Railway/
Render deployment to run the browser side.

**Hosting model.** Requires a separately running `steel-browser` service. Adds
infra: Docker container, port 3000 (API), port 9223 (CDP debugger).

**Bun compatibility.** SDK is a pure TypeScript REST client — fully Bun
compatible. But the server is Node.js Docker.

**storageState (S15).** Sessions are managed server-side; cookie injection is
via the REST API. Works but is more indirection than local Playwright.

**History.pushState injection (S16).** Possible via remote CDP, but requires
the network hop to the Docker container for every `evaluate` call.

**Last release.** `steel-sdk@0.18.0` on 2026-03-16. The `steel-browser` repo
shows `v0.5.3-beta` on 2026-04-24. Moderate activity.

**License.** Apache-2.0.

**Cost.** Self-hosted: zero infra cost beyond Docker. Cloud (app.steel.dev):
paid.

**Cons.** Violates the "no separate service for the driver alone" constraint.
Adds Docker dependency and network latency for every browser action. No
semantic LLM action layer — we would still need to build `act()` on top.
Effectively solves the *hosting* problem but not the *semantic action* problem.
Ruled out as a standalone choice.

---

### Option D — Anthropic Computer Use loop (reference architecture)

Anthropic's computer-use demo uses Claude claude-sonnet-4-6's vision to select
pixel coordinates and issue click/type actions. Requires screenshot-per-step,
a vision-capable model, and significantly higher latency and token cost per
action. No TypeScript SDK or npm package; must be hand-rolled.

Not viable: screenshot-per-step latency is incompatible with pentest throughput
requirements, pixel-coordinate targeting is maximally brittle, and there is no
packaged integration.

---

## Options Summary Table

| Dimension | Stagehand v3 (A) | playwright-mcp (B) | steel-sdk + Docker (C) |
|-----------|------------------|--------------------|------------------------|
| Semantic action API | `act / observe / extract / agent` | MCP tool-call JSON | None (raw Playwright sessions) |
| Action API maturity | Stable since v1; v3 CDP rewrite weeks old | Pre-1.0 alpha | N/A |
| Playwright dependency | Optional (CDP-native) | Hard dep (1.60.0-alpha) | Optional (remote) |
| Bun compat | Yes (v3 explicit) | Yes (Node compat mode) | SDK yes; server Docker/Node |
| Hosting model | Local CDP | In-process MCP server | Remote Docker container |
| Separate service required | No | No | Yes — violates constraint |
| storageState (S15) | Via Playwright adapter or CDP | Native | Via REST session API |
| pushState injection (S16) | `page.evaluate` / CDP direct | `browser_evaluate` tool | Remote CDP evaluate |
| License | MIT | Apache-2.0 | Apache-2.0 |
| Last release | 2026-04-27 | 2026-04-30 | SDK 2026-03-16 |
| Commercial cost | Free (local) | Free | Free (self-hosted) |
| Infra overhead | None | None | Docker container |

---

## Decision

**Adopt Stagehand v3 (`@browserbasehq/stagehand@^3.3.0`) as the semantic
action layer above the existing raw Playwright low-level paths in
`services/browser-worker/`.**

### Rationale

1. **Stagehand is the only option that directly solves the semantic action
   problem without adding a separate process or service.** `playwright-mcp`
   requires an MCP protocol hop for every action; `steel-sdk` requires a Docker
   container; neither ships a first-class `act("natural language")` SDK.

2. **v3's CDP-native architecture is Bun-compatible by design.** The prior Bun
   blocker was Playwright's Node-API surface; v3 bypasses it. We can still use
   `playwright-core` as an optional Stagehand driver to keep the existing low-
   level Playwright paths intact (HAR recording, trace files, screenshot via
   CDP).

3. **Stagehand is MIT-licensed and can be used commercially without
   restriction.**

4. **The `BrowserDriver` interface (`launch / navigate / close`) is preserved.**
   Stagehand is introduced as an internal implementation detail of the new
   `StagehandBrowserDriver` class; the worker, the queue protocol, and all
   upstream callers remain unchanged.

5. **No new infra.** Stagehand runs in-process. No sidecar, no Docker, no
   Redis.

6. **Optional Browserbase cloud** can be enabled later (feature flag in
   `BROWSER_DRIVER=stagehand-cloud`) if we need isolated browser sandboxes per
   tenant without running local Chromium at scale. For now, local CDP.

The v3 recency risk (weeks-old CDP rewrite) is accepted. The underlying CDP
protocol is stable; Stagehand is one of the best-resourced browser-automation
projects (Browserbase raised $18M, team includes former Playwright contributors).
We pin a minor version (`^3.3.0`) and review on each sprint.

---

## Integration Sketch

### Files that change in `services/browser-worker/`

```
services/browser-worker/
  src/
    real-driver.ts          ← replace NotImplementedError stub with
                              StagehandBrowserDriver (wraps Stagehand CDP session)
    select.ts               ← add 'stagehand' to BrowserDriverChoice enum;
                              BROWSER_DRIVER=stagehand | stagehand-cloud | fake | real
    types.ts                ← add SemanticActionRequest (optional, for S15 recipe)
    stagehand-driver.ts     ← new file: StagehandBrowserDriver implements BrowserDriver
    stagehand-session.ts    ← new file: per-session Stagehand instance lifecycle
```

`RealBrowserDriver` is not deleted — it remains as the low-level Playwright
path for direct CDP calls (HAR, trace zip, performance timeline) that Stagehand
delegates down to anyway. The selector-level driver is still valid for simple
`GET` navigation where no semantic actions are needed.

### New dep in `package.json`

```jsonc
// services/browser-worker/package.json
{
  "dependencies": {
    "@browserbasehq/stagehand": "^3.3.0"
  }
}
```

Playwright is already present as a project-level dep (E2E tests). Stagehand's
optional `playwright-core` dep is satisfied by the workspace's existing
`playwright` installation without a separate install.

### S15 recipe-driven login

A recipe is a JSON array of steps:
```jsonc
[
  { "action": "navigate", "url": "https://target.example/login" },
  { "action": "act", "instruction": "fill the username field with {username}" },
  { "action": "act", "instruction": "fill the password field with {password}" },
  { "action": "act", "instruction": "click the login button" },
  { "action": "wait", "selector": "[data-testid=dashboard]" }
]
```

`StagehandBrowserDriver.login(recipe, credentials)` iterates the steps,
calling `stagehand.act(instruction)` for semantic steps and
`page.goto(url)` for navigation. After completion it calls
`stagehand.context.storageState()` (via the Playwright adapter) and writes
the result to the `storageState` field of `BrowserSession` — the same format
Sprint 15 expects. Future jobs for the same `(tenantId, assessmentId)` load
this state on `driver.launch()`.

### S16 SPA route discovery — `History.pushState` observer coexistence

Stagehand v3 exposes `stagehand.page` as the underlying CDP page handle.
Sprint 16's observer is injected via:

```typescript
await stagehand.page.addInitScript(() => {
  const orig = history.pushState.bind(history);
  history.pushState = (...args) => {
    orig(...args);
    window.__csRouteCapture?.({ type: 'pushState', url: location.href });
  };
});
```

`addInitScript` runs before every page load, so the observer is present even
after in-app navigation. Stagehand's CDP layer does not interfere with this
injection — it operates on the same `Page` object via the `page` handle.

---

## Migration Plan

### Phase 1 — keep existing low-level paths (current sprint, no change)

`FakeBrowserDriver` and `RealBrowserDriver` remain. `selectBrowserDriver`
continues to return `RealBrowserDriver` for `BROWSER_DRIVER=real`.

### Phase 2 — add `StagehandBrowserDriver` (Sprint 15)

1. Add `@browserbasehq/stagehand@^3.3.0` to `services/browser-worker/`.
2. Implement `stagehand-session.ts`: wraps `new Stagehand({ ... })` lifecycle,
   holds the session map (`Map<string, StagehandSession>`).
3. Implement `stagehand-driver.ts`: `StagehandBrowserDriver` implements
   `BrowserDriver`. `navigate()` calls `stagehand.page.goto(url)` for the
   low-level navigation outcome (HAR, screenshot, DOM snapshot) and exposes
   `actOn(steps)` for recipe execution.
4. Extend `select.ts`: `BROWSER_DRIVER=stagehand` → `StagehandBrowserDriver`.
5. Integration tests run with `BROWSER_DRIVER=stagehand` against the lab
   fixture (Sprint 9 local Chromium). FakeDriver tests are unaffected.

### Phase 3 — deprecate `RealBrowserDriver` stub (Sprint 16 or 17)

Once `StagehandBrowserDriver` covers all `navigate` paths and integration tests
are green, `RealBrowserDriver` is removed. `select.ts` drops `'real'` from the
known choices.

At no point are existing tests modified. The `FakeBrowserDriver` test suite
remains the primary fast-path unit test target.

---

## Consequences

### Accepted benefits

- LLM agents can express browser actions in natural language; no CSS selector
  maintenance.
- `act / observe / extract` primitives map directly onto Sprint 15 login
  recipes and Sprint 16 form-enumeration passes.
- Stagehand v3 is Bun-native; no Node.js subprocess or shim required.
- MIT license; zero additional infra; optional Browserbase cloud upgrade path.
- The `BrowserDriver` interface is unchanged; all callers (worker, tests,
  coordinator) are unaffected.

### Accepted costs

- Stagehand v3 CDP rewrite is 3 weeks old at decision time (2026-04-30).
  Pinning `^3.3.0` limits exposure; we will review on Sprint 16.
- Dependency tree is larger than raw Playwright: adds `ai`, `openai`,
  `@anthropic-ai/sdk`, and provider shims as optional packages. We install
  only the providers we use (`@ai-sdk/anthropic`) and audit the lockfile.
- Stagehand's `engines` field requires Node >=20.19.0; Bun 1.3 reports Node 22
  compatibility. If a future Bun release breaks this, the fallback is the
  Playwright adapter path (Stagehand optional dep).
- No built-in HAR recording in v3 CDP mode. We implement HAR capture in
  `stagehand-driver.ts` via `page.on('request')`/`page.on('response')` events
  (the same approach the current `FakeBrowserDriver` stubs), or by activating
  the optional `playwright-core` adapter which has native HAR support.

### Not accepted (ruled out)

- Python sidecar for browser automation (violates constraint).
- `steel-browser` Docker container as the driver (violates "no separate service"
  constraint).
- Anthropic computer-use vision loop (latency + cost incompatible with pentest
  throughput).
- `@playwright/mcp` as primary driver (pre-1.0 alpha, IPC overhead per action,
  not designed for library embedding).

---

## Outcome (2026-04-30)

**Actual implementation:** Sprints 15 and 16 shipped recipe-driven auth and SPA route
discovery using raw Playwright APIs (`page.goto`, `page.evaluate`, `context.route`,
`page.addInitScript`) without `@browserbasehq/stagehand`.

**Deviation from ADR recommendation:** The ADR recommended adopting Stagehand v3.
Actual sprints chose raw Playwright because:
1. S15 auth recipes were implementable with selector-based Playwright steps.
2. S16 SPA observer injection (`page.addInitScript`) needed no semantic act() layer.
3. Stagehand v3 was weeks old at ADR authoring time — deferred for stability.

**Current state:** `RealBrowserDriver` (raw Playwright) is the active production driver.
`StagehandBrowserDriver` remains unimplemented (Phase 4 scope).

**Phase 4 reconsider:** When multi-step semantic form interaction beyond simple recipe
steps is required, revisit Stagehand v3 adoption per this ADR's Option A rationale.
