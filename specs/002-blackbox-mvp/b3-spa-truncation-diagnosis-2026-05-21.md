# B3 — Cloudflare→origin SPA bundle truncation

**Date**: 2026-05-21
**Severity**: CRITICAL — browser users cannot use the app (SPA never hydrates)
**Status**: Diagnosed, operator-action required (CF Dashboard)

## TL;DR

The main SPA JS bundle `/assets/index-DOZgcnEZ.js` is **526285 bytes at origin** but Cloudflare truncates the response at **~20–25 KB** before the connection stalls indefinitely. Origin (Caddy) is healthy. Cause is on the Cloudflare edge.

**Recommended fix**: Operator must disable **Auto Minify for JS** AND **Rocket Loader** in the Cloudflare Dashboard for `tensol.ru` (option **A + B** from runbook).

## Measurements (2026-05-21, ~10:09–10:13 UTC)

| Test | URL | Result | Notes |
|---|---|---|---|
| Origin direct (curl `--resolve` → 5.42.106.25) | `https://tensol.ru/assets/index-DOZgcnEZ.js` | **526285 bytes** in 0.31–0.44 s | `Content-Length: 526285`, strong ETag `"tfdqwuba31"`, `server: Caddy` |
| Through CF, default `Accept-Encoding` (`gzip, deflate, br, zstd`) | same | **stall after 20508 bytes**, timeout @ 30 s | `cf-cache-status: HIT`, weak ETag `W/"tfdqwuba31"` |
| Through CF, `Accept-Encoding: identity` | same | **stall after 24606 bytes** | |
| Through CF, `Accept-Encoding: gzip` | same | **stall after 23246 bytes** | |
| Through CF, `Accept-Encoding: br` | same | **stall after 20508 bytes** | |
| Through CF, `Accept-Encoding:` (empty) | same | **stall after 20508 bytes** | |
| Through CF, cache-bust `?bust=NNNN` | forces `cf-cache-status: MISS` | **stall after 22511 bytes** | proves issue is not stale cache |
| Through CF, CSS `/assets/index-ttpU46YB.css` (4618 B) | same host | **OK — 4618 bytes** | small assets pass cleanly |
| `app.tensol.ru` (same CF + same origin) | same JS path | **stall after 25240 bytes** | confirms CF-side, not host-specific |

**Byte-identity check**: SHA256 of first 20000 bytes from CF == SHA256 of first 20000 bytes from origin
(`6c95105377a2a518ad08e5f5c30d966a688619a94e8afb8383aed2ebe87124f2`). CF is **not rewriting** the body bytes it does send — it streams the first chunk(s) verbatim then the connection halts.

## Header diff (CF vs origin)

```
CF:                                          Origin (Caddy):
HTTP/2 200                                   HTTP/2 200
date: ...                                    date: ...
content-type: text/javascript; charset=utf-8 content-type: text/javascript; charset=utf-8
server: cloudflare                           server: Caddy
etag: W/"tfdqwuba31"           ← WEAK        etag: "tfdqwuba31"             ← STRONG
cache-control: max-age=14400                 (none)
cf-cache-status: HIT|MISS|...                accept-ranges: bytes
cf-ray: 9ff2c8a26e342d5d-ARN                 content-length: 526285        ← present
vary: Accept-Encoding                        (no content-length on CF — chunked)
```

Critical signals:
- CF demotes the ETag from strong (`"…"`) to weak (`W/"…"`), which CF does when it plans to re-encode (compress / minify / transform) the response.
- CF strips `Content-Length` and uses chunked transfer-encoding, but never sends a terminating chunk on the big bundle, leaving the HTTP/2 stream open until curl times out.
- The break-point is non-deterministic (20508 / 22511 / 23246 / 24606 / 25240) — varies per encoding and per cache state, consistent with an internal CF transformer abandoning streaming after parsing the first ~1 stream-chunk worth of input.

## Origin Caddyfile (read from `5.42.106.25:/etc/caddy/Caddyfile`)

Origin is healthy. Caddy responds in <500 ms with the full 526 KB body, strong ETag, `accept-ranges: bytes`, and proper `Content-Length`. Caddy serves `tls internal` (self-signed) on :443, which means Cloudflare's Origin SSL mode is **Full** (not Full strict) — this is correct configuration but worth noting for the operator (a real Origin Cert is the production-clean fix and unrelated to this bug).

`encode gzip zstd` is enabled in Caddy, which is fine — CF requests with `Accept-Encoding: gzip` and Caddy returns gzipped or identity bytes correctly to direct probes.

## Caddy logs (5.42.106.25)

`journalctl -u caddy` shows only startup TLS-cert acquisition (clean), no errors, no warnings during the test window. No access log is configured (no `log` directive in Caddyfile), so per-request entries are not available. Adding access logs in a follow-up is recommended but not required for this fix.

## Root cause (one sentence)

Cloudflare is applying a content transformation (most likely **Auto Minify → JavaScript** and/or **Rocket Loader**) to a 526 KB Vite-bundled JS payload, the transformer fails to complete on the large minified input, and CF leaves the HTTP/2 stream half-open after emitting the first ~20–25 KB.

This is a well-documented CF footgun on bundlers (Vite, Webpack, Rollup) whose output is already minified; CF's parser chokes on shrunk syntax it doesn't expect. The byte-identical first 20 KB rules out a CF Worker / Origin Rule that rewrites payload — it's a streaming transformer that buffers, fails, and abandons.

## Recommended fix (ranked)

### A (PRIMARY — operator action in CF Dashboard)

Disable Auto Minify for JS on `tensol.ru`:

1. Cloudflare Dashboard → select zone `tensol.ru`
2. Left sidebar → **Speed** → **Optimization** → **Content Optimization**
3. Find **Auto Minify** card → **uncheck JavaScript** (also uncheck CSS and HTML for safety — Vite already minifies all three)
4. Click **Save**

### B (PRIMARY — operator action in CF Dashboard)

Disable Rocket Loader on `tensol.ru`:

1. Cloudflare Dashboard → select zone `tensol.ru`
2. Left sidebar → **Speed** → **Optimization** → **Content Optimization**
3. Find **Rocket Loader** card → toggle to **Off**
4. Click **Save**

### Post-fix verification (operator runs this after A+B)

```bash
# Purge CF cache for the JS asset
# Dashboard → Caching → Configuration → Purge Cache → Custom Purge:
#   https://tensol.ru/assets/index-DOZgcnEZ.js
#   https://app.tensol.ru/assets/index-DOZgcnEZ.js

# Then re-test:
ASSET=$(curl -sS https://tensol.ru/ | grep -oE '/assets/index-[a-zA-Z0-9_-]+\.js' | head -1)
curl -sS -w "size: %{size_download}\ntime: %{time_total}\n" -o /tmp/cf.js "https://tensol.ru$ASSET" -m 30
wc -c /tmp/cf.js
# EXPECTED: size: 526285  (matches origin)
```

### C / D / E (fallback options if A+B don't fix)

- **C**: CF Page Rule excluding `tensol.ru/assets/*` from CF processing (Cache Level: Bypass, Disable Performance). Higher cost, only if A+B insufficient.
- **D**: Caddyfile change — split `/assets/*` into its own block that disables encoding (`encode off` is not a Caddy directive — would need to drop `import common_headers` and not call `encode`). This is a workaround for CF re-encoding a Caddy-encoded body, but our diagnostic showed CF stalls even with `Accept-Encoding: identity`, so this is unlikely to help and is **not recommended**.
- **E**: CF Origin Rule with "Cache Status: Bypass cache" for `/assets/*`. Useful if A+B fix the connection but caching still serves the stale broken object — operator should also **purge the cache** for the affected asset after A+B (instructions above).

## Why no code fix was applied

The bug is **entirely on the Cloudflare edge** — origin serves the bundle correctly and is byte-identical to what CF emits before stalling. No Caddyfile change can fix a CF transformer that fails on the upstream payload. The Caddy `encode off` approach (option D) would not help because CF stalls even on `Accept-Encoding: identity` requests where origin returns uncompressed bytes. Operator must touch the CF Dashboard.

## BLOCKER

Fix requires operator action in Cloudflare Dashboard for zone `tensol.ru`. Follow steps A and B above. After saving, purge cache for `/assets/index-DOZgcnEZ.js` on both `tensol.ru` and `app.tensol.ru`, then run the verification curl.
