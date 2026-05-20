#!/bin/bash
# grant-yc-iam-roles.sh — Step-4-fix
#
# Grants the prod Tensol SA (ajebdg35q6f107q3jl9k) the two roles it needs to
# spawn ephemeral VPS in folder b1g62rnc9735lbms9klh:
#   - compute.editor  (create/delete/start/stop VMs, attach disks)
#   - vpc.user        (attach VM NICs to the project's subnet)
#
# IMPORTANT: this script is NOT executed automatically. Run it from a machine
# where `yc` CLI is logged in as a USER ACCOUNT (federation login or OAuth)
# with folder-owner / resource-manager.admin rights on the prod folder.
# Neither of the two existing SA keys (PROD / TEST) has resource-manager
# permissions on this folder — see specs/002-blackbox-mvp/yc-iam-analysis-2026-05-20.md.
#
# Verify yc auth first:
#   yc config list
#   yc iam whoami    # should print a user-account-id (uid:...), NOT a serviceAccountId
#
# Usage:
#   bash scripts/grant-yc-iam-roles.sh

set -euo pipefail

FOLDER_ID="b1g62rnc9735lbms9klh"
PROD_SA_ID="ajebdg35q6f107q3jl9k"

echo "==> Granting compute.editor to ${PROD_SA_ID} on folder ${FOLDER_ID}"
yc resource-manager folder add-access-binding "$FOLDER_ID" \
  --role compute.editor \
  --subject "serviceAccount:$PROD_SA_ID"

echo "==> Granting vpc.user to ${PROD_SA_ID} on folder ${FOLDER_ID}"
yc resource-manager folder add-access-binding "$FOLDER_ID" \
  --role vpc.user \
  --subject "serviceAccount:$PROD_SA_ID"

echo "==> Verifying current bindings for ${PROD_SA_ID}:"
yc resource-manager folder list-access-bindings "$FOLDER_ID" \
  --format json | grep -A1 "$PROD_SA_ID" || {
    echo "WARN: grep returned nothing — print full list for manual inspection:" >&2
    yc resource-manager folder list-access-bindings "$FOLDER_ID"
  }

echo "==> Done. Re-run server/src/vps tests that hit real Yandex (e.g. T047)."

# ─── REST-API equivalent (no yc CLI) ─────────────────────────────────────────
#
# 1. Get a user-account IAM token (NOT from an SA key):
#       yc iam create-token              # if you have yc CLI auth'd as user
#    OR open https://oauth.yandex.ru/authorize?response_type=token&client_id=1a6990aa636648e9b2ef855fa7bec2fb
#    then exchange the OAuth token:
#       curl -X POST https://iam.api.cloud.yandex.net/iam/v1/tokens \
#         -H "Content-Type: application/json" \
#         -d '{"yandexPassportOauthToken":"<oauth_token>"}'
#
# 2. ADMIN_TOKEN=<paste iamToken from step 1>
#
# 3. Patch the folder's access bindings:
#    curl -X POST \
#      "https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders/b1g62rnc9735lbms9klh:updateAccessBindings" \
#      -H "Authorization: Bearer $ADMIN_TOKEN" \
#      -H "Content-Type: application/json" \
#      -d '{
#        "accessBindingDeltas": [
#          {"action":"ADD","accessBinding":{"roleId":"compute.editor",
#             "subject":{"id":"ajebdg35q6f107q3jl9k","type":"serviceAccount"}}},
#          {"action":"ADD","accessBinding":{"roleId":"vpc.user",
#             "subject":{"id":"ajebdg35q6f107q3jl9k","type":"serviceAccount"}}}
#        ]
#      }'
#
# 4. Verify:
#    curl -X GET \
#      "https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders/b1g62rnc9735lbms9klh:listAccessBindings" \
#      -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.accessBindings[] | select(.subject.id=="ajebdg35q6f107q3jl9k")'
#
# ─── Web-UI fallback ─────────────────────────────────────────────────────────
#
# https://console.cloud.yandex.com/folders/b1g62rnc9735lbms9klh/access-bindings
#   1. Click "Assign roles"
#   2. Subject: service account → ajebdg35q6f107q3jl9k (tensol-prod)
#   3. Roles: compute.editor, vpc.user
#   4. Save.
