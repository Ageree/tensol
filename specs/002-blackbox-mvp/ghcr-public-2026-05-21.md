# GHCR `tensol-vps-agent` Public-Visibility Evidence

**Date:** 2026-05-21
**Operator:** Claude (Opus 4.7) on branch `002-blackbox-mvp`
**Purpose:** Document that the container image
`ghcr.io/ageree/tensol-vps-agent` is publicly pullable without GHCR auth, so
ephemeral GCP VMs spawned by `spawnVm()` can `docker pull` it during
each blackbox scan.

---

## Before

State as observed when this task began:

```
gh api /user/packages/container/tensol-vps-agent --jq '.visibility'
public
```

Inspection of the full package payload showed:

- `id`: `12326308`
- `package_type`: `container`
- `owner.login`: `Ageree` (user, not org)
- `version_count`: `3`
- `visibility`: **`public`**
- `repository.full_name`: `Ageree/tensol`
- `repository.private`: `false`
- `created_at`: `2026-05-20T20:50:41Z`

The package was therefore **already public** by the time this verification
ran. The earlier assumption that the image inherited `private` from the repo
turned out to be wrong — the `Ageree/tensol` repo itself is also public
(`"private": false`), and the GHCR image visibility matched.

**No PATCH call was needed.** No state was mutated.

---

## API Call(s) Performed

```
$ gh api /user/packages/container/tensol-vps-agent
# returned the full package JSON (HTTP 200), visibility=public

$ gh api /user/packages/container/tensol-vps-agent --jq '.visibility'
public

$ curl -sS https://ghcr.io/v2/ageree/tensol-vps-agent/tags/list \
    -H "Authorization: Bearer <anon-token>"
{"name":"ageree/tensol-vps-agent","tags":[
  "002-blackbox-mvp-09c10e8",
  "002-blackbox-mvp-latest"
]}
```

No `PATCH` was issued because no flip was required.

---

## After

Visibility unchanged: **`public`**. Two tags are available:

- `002-blackbox-mvp-09c10e8` (immutable, commit-pinned — the recommended ref
  for production spawnVm pulls)
- `002-blackbox-mvp-latest` (moving tag for dev)

---

## Unauthenticated Pull Verification

GHCR requires an anonymous bearer token even for public images (the registry
follows the OCI distribution spec: clients without creds first fetch a
short-lived token, then use it on the manifest endpoint).

### Step 1 — bare manifest call without any token

```
$ curl -sS -o /dev/null -w "%{http_code}\n" \
    https://ghcr.io/v2/ageree/tensol-vps-agent/manifests/002-blackbox-mvp-latest
401
```

`401` is **expected** even for public images — the response carries a
`Www-Authenticate: Bearer realm="https://ghcr.io/token",...` header telling
the client to fetch a token first.

### Step 2 — proper OCI flow (anonymous token, then manifest)

```
$ TOKEN=$(curl -sS \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:ageree/tensol-vps-agent:pull" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

$ echo "Token len: ${#TOKEN}"
Token len: 64

$ curl -sS -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json,\
application/vnd.docker.distribution.manifest.list.v2+json,\
application/vnd.docker.distribution.manifest.v2+json" \
    https://ghcr.io/v2/ageree/tensol-vps-agent/manifests/002-blackbox-mvp-latest
200
```

**`HTTP 200`** confirms the manifest is fetchable without any user
credentials — only the public anonymous-pull token. This is exactly what
`docker pull` does internally on a fresh VM with no GHCR login.

### What this means for `spawnVm()`

When a fresh GCP VM runs its cloud-init script with:

```
docker pull ghcr.io/ageree/tensol-vps-agent:002-blackbox-mvp-09c10e8
```

…the Docker daemon performs the same anonymous token dance shown above and
pulls the manifest + layers successfully. **No GHCR PAT needs to be injected
into VM metadata.** The 401-then-200 flow is the normal OCI handshake.

---

## Implications

- `spawnVm()` cloud-init may pull the image with no credentials.
- No GHCR PAT lifecycle / rotation needed on the VM side.
- Switching the workflow to push only commit-pinned tags (drop `-latest`) is
  recommended for production scans to keep pull behavior deterministic — see
  `.github/workflows/build-vps-agent.yml`.

---

## No-Op Outcome

This task was queued under the assumption a visibility flip was required.
Verification shows the flip already happened (or never needed to happen — the
repo and package were both public from the start). The evidence above
documents the current public state so future audits do not have to re-run the
investigation.

If the image is ever flipped back to private (e.g. someone toggles it in the
GitHub UI), spawnVm cloud-init will start failing with `unauthorized` errors.
At that point, re-run:

```
gh api -X PATCH /user/packages/container/tensol-vps-agent \
    --field visibility=public
```

…and re-verify with the two-step curl flow above.
