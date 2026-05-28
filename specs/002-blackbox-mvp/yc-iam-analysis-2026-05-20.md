# Yandex Cloud IAM Analysis — Step-4 Fix

**Date:** 2026-05-20
**Branch:** `002-blackbox-mvp`
**Trigger:** T047 real-Yandex test failed at `spawnVm` with `HTTP 403 PERMISSION_DENIED`.
**Goal:** Identify which (if either) of the two SA keys in `server/.env.yandex` has
the IAM admin rights needed to grant `compute.editor` + `vpc.user` to the prod SA
on folder `b1g62rnc9735lbms9klh`.

## TL;DR

**Neither** SA has resource-manager rights on either folder. The operator MUST
grant roles from a **user account** (folder owner) — not from any of the SA
keys we currently hold.

Run: `bash scripts/grant-yc-iam-roles.sh` (after `yc init` as user account)
or use the web-UI fallback below.

---

## Service Accounts in `server/.env.yandex`

| Env var                      | Role label | SA id (`service_account_id`) | Key id (`id`)           |
|------------------------------|------------|------------------------------|--------------------------|
| `YANDEX_SA_KEY_JSON`         | PROD       | `ajebdg35q6f107q3jl9k`       | `ajek2tkbfpocelek69eo`   |
| `YANDEX_TEST_SA_KEY_JSON`    | TEST       | `ajetbk1rjqljfq66g18l`       | `aje2jg7i4rioeqq5ss2c`   |

SA ids and key ids are **not secrets**; only the `private_key` PEM is sensitive.
The `scripts/yc-iam-introspect.ts` script strips any PEM material from its
output before writing to stdout.

## Folders

| Env var                    | Folder id                |
|----------------------------|--------------------------|
| `YANDEX_PROD_FOLDER_ID`    | `b1g62rnc9735lbms9klh`   |
| `YANDEX_TEST_FOLDER_ID`    | `b1gto44i6n2uls1slfa9`   |

## Introspection Result (raw)

Generated via `bun run scripts/yc-iam-introspect.ts` on 2026-05-20:

```json
{
  "folderId": "b1g62rnc9735lbms9klh",
  "timestamp": "2026-05-20T20:38:21.645Z",
  "results": [
    {
      "label": "PROD",
      "envVar": "YANDEX_SA_KEY_JSON",
      "saId": "ajebdg35q6f107q3jl9k",
      "keyId": "ajek2tkbfpocelek69eo",
      "iamTokenStatus": "ok",
      "listBindingsStatus": 403,
      "listBindingsError": "HTTP 403 Forbidden :: Permission denied",
      "bindings": null,
      "hasResourceManagerAdmin": false,
      "canModifyBindings": false
    },
    {
      "label": "TEST",
      "envVar": "YANDEX_TEST_SA_KEY_JSON",
      "saId": "ajetbk1rjqljfq66g18l",
      "keyId": "aje2jg7i4rioeqq5ss2c",
      "iamTokenStatus": "ok",
      "listBindingsStatus": 403,
      "listBindingsError": "HTTP 403 Forbidden :: Permission denied",
      "bindings": null,
      "hasResourceManagerAdmin": false,
      "canModifyBindings": false
    }
  ]
}
```

Additional probe: `TEST SA → TEST folder b1gto44i6n2uls1slfa9` also returned
**HTTP 403 Permission denied**. Both SAs are isolated to compute (one of them
only partially, per T047) and have no `resource-manager.*` role on any folder.

### Interpretation

- **IAM-token exchange ✓ for both SAs.** JWT signing + `iam/v1/tokens` flow is
  intact. Confirms `server/src/vps/yandex-iam.ts` is correct.
- **`listAccessBindings` denied for both.** Neither SA holds even
  `resource-manager.viewer` on either folder, so they cannot read — let alone
  modify — IAM bindings.
- Conclusion: there is no «admin SA» hiding in our credentials. The original
  `yc` provisioning gave the SAs compute-scoped roles only (and apparently
  even those are incomplete for the prod SA on the prod folder).

## Recommended Action (operator must execute)

**Path 1 — `yc` CLI as user (preferred):**

```bash
# Log in once as the human owner of the cloud (NOT as a service account):
yc init                       # OAuth-token flow, opens browser
yc iam whoami                 # confirm subject is uid:... (user), not serviceAccount:...

bash scripts/grant-yc-iam-roles.sh
```

The script grants `compute.editor` + `vpc.user` to
`serviceAccount:ajebdg35q6f107q3jl9k` on folder `b1g62rnc9735lbms9klh`, then
prints the resulting binding list for verification.

**Path 2 — REST API (no `yc`):** see the embedded curl recipe in
`scripts/grant-yc-iam-roles.sh`. Requires obtaining a user-account IAM token
via `yandexPassportOauthToken` exchange.

**Path 3 — Web UI fallback:**

<https://console.cloud.yandex.com/folders/b1g62rnc9735lbms9klh/access-bindings>

1. «Assign roles» → subject = service account `ajebdg35q6f107q3jl9k` (tensol-prod).
2. Roles: `compute.editor`, `vpc.user`.
3. Save.

## After grant: verification

Re-run the real-Yandex T047 test (or equivalent `spawnVm` smoke):

```bash
cd server && YANDEX_REAL=1 bun test src/vps/yandex-real.test.ts
```

Expected: `spawnVm` returns a 2xx response with a VM id; subsequent `deleteVm`
must succeed. Watch for orphans via:

```bash
yc compute instance list --folder-id b1g62rnc9735lbms9klh
```

## Safety notes

- `scripts/yc-iam-introspect.ts` is **read-only** — it lists bindings but never
  patches them. It also strips PEM blocks from output as a defense-in-depth
  measure.
- `scripts/grant-yc-iam-roles.sh` was **not executed** by the agent — it is
  documentation that the operator runs from a privileged user-account context.
- $0 spend, 0 orphan VMs were created during introspection.
