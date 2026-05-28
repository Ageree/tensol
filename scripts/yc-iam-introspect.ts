#!/usr/bin/env bun
/**
 * yc-iam-introspect.ts — Step-4-fix
 *
 * Reads BOTH Yandex Cloud SA keys from server/.env.yandex
 * (YANDEX_SA_KEY_JSON = prod, YANDEX_TEST_SA_KEY_JSON = test),
 * mints an IAM token for each, then queries
 *   GET .../resource-manager/v1/folders/{folderId}:listAccessBindings
 * to enumerate which roles each SA currently holds on the prod folder.
 *
 * Safe by design:
 *   - Read-only. NEVER mutates IAM bindings.
 *   - NEVER prints private_key. Only SA-id, key-id, role list, HTTP status.
 *
 * Usage:
 *   bun run scripts/yc-iam-introspect.ts
 *
 * Output: JSON report on stdout; non-zero exit if both SAs fail.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPrivateKey, sign, constants as cryptoConstants } from "node:crypto";

const IAM_TOKEN_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
const RESOURCE_MANAGER_BASE =
  "https://resource-manager.api.cloud.yandex.net/resource-manager/v1";
const JWT_TTL_SECONDS = 3600;

const ENV_PATH = resolve(import.meta.dir, "..", "server", ".env.yandex");
const PROD_FOLDER_ID_VAR = "YANDEX_PROD_FOLDER_ID";

type SaKey = {
  id: string;
  service_account_id: string;
  private_key: string;
};

type IntrospectionResult = {
  label: string;
  envVar: string;
  saId: string | null;
  keyId: string | null;
  iamTokenStatus: "ok" | "failed";
  iamTokenError: string | null;
  listBindingsStatus: number | null;
  listBindingsError: string | null;
  bindings: AccessBinding[] | null;
  hasResourceManagerAdmin: boolean;
  canModifyBindings: boolean;
};

type AccessBinding = {
  roleId: string;
  subject: { id: string; type: string };
};

function parseEnvFile(path: string): Map<string, string> {
  const text = readFileSync(path, "utf8");
  const env = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    // Strip surrounding single or double quotes if present.
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env.set(k, v);
  }
  return env;
}

function parseSaKey(raw: string): SaKey {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : Buffer.from(trimmed, "base64").toString("utf8");
  const obj = JSON.parse(jsonText) as Partial<SaKey>;
  if (!obj.id || !obj.service_account_id || !obj.private_key) {
    throw new Error("SA key missing required fields (id, service_account_id, private_key)");
  }
  return {
    id: obj.id,
    service_account_id: obj.service_account_id,
    private_key: obj.private_key,
  };
}

function signJwt(sa: SaKey, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + JWT_TTL_SECONDS;
  const header = base64url(
    JSON.stringify({ typ: "JWT", alg: "PS256", kid: sa.id }),
  );
  const claims = base64url(
    JSON.stringify({
      iss: sa.service_account_id,
      aud: IAM_TOKEN_URL,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(sa.private_key);
  const sig = sign("RSA-SHA256", Buffer.from(signingInput), {
    key,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return `${signingInput}.${sig.toString("base64url")}`;
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

async function mintIamToken(sa: SaKey): Promise<string> {
  const jwt = signJwt(sa, Date.now());
  const resp = await fetch(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "<unreadable>");
    throw new Error(`HTTP ${resp.status} ${resp.statusText} :: ${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { iamToken?: string };
  if (!data.iamToken) throw new Error("response missing iamToken");
  return data.iamToken;
}

async function listFolderAccessBindings(
  iamToken: string,
  folderId: string,
): Promise<{ status: number; bindings: AccessBinding[] | null; error: string | null }> {
  const url = `${RESOURCE_MANAGER_BASE}/folders/${folderId}:listAccessBindings`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${iamToken}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "<unreadable>");
    return {
      status: resp.status,
      bindings: null,
      error: `HTTP ${resp.status} ${resp.statusText} :: ${body.slice(0, 300)}`,
    };
  }
  const data = (await resp.json()) as { accessBindings?: AccessBinding[] };
  return {
    status: resp.status,
    bindings: data.accessBindings ?? [],
    error: null,
  };
}

const RESOURCE_MANAGER_ADMIN_ROLES = new Set([
  "admin",
  "resource-manager.admin",
  "resource-manager.clouds.owner",
  "resource-manager.folders.owner",
]);

async function introspectSa(
  label: string,
  envVar: string,
  rawKey: string | undefined,
  folderId: string,
  selfSaIdHint: string | null,
): Promise<IntrospectionResult> {
  const base: IntrospectionResult = {
    label,
    envVar,
    saId: null,
    keyId: null,
    iamTokenStatus: "failed",
    iamTokenError: null,
    listBindingsStatus: null,
    listBindingsError: null,
    bindings: null,
    hasResourceManagerAdmin: false,
    canModifyBindings: false,
  };
  if (!rawKey) {
    base.iamTokenError = `${envVar} not set in .env.yandex`;
    return base;
  }
  let sa: SaKey;
  try {
    sa = parseSaKey(rawKey);
  } catch (err) {
    base.iamTokenError = `parse failure: ${(err as Error).message}`;
    return base;
  }
  base.saId = sa.service_account_id;
  base.keyId = sa.id;

  let iamToken: string;
  try {
    iamToken = await mintIamToken(sa);
    base.iamTokenStatus = "ok";
  } catch (err) {
    base.iamTokenError = (err as Error).message;
    return base;
  }

  const list = await listFolderAccessBindings(iamToken, folderId);
  base.listBindingsStatus = list.status;
  base.listBindingsError = list.error;
  base.bindings = list.bindings;

  if (list.bindings) {
    // We only care about bindings WHERE the subject is THIS SA.
    const selfBindings = list.bindings.filter(
      (b) => b.subject.id === sa.service_account_id,
    );
    base.hasResourceManagerAdmin = selfBindings.some((b) =>
      RESOURCE_MANAGER_ADMIN_ROLES.has(b.roleId),
    );
    // Heuristic: an SA can modify bindings if it has admin/owner OR
    // resource-manager.folders.admin on this folder.
    base.canModifyBindings = base.hasResourceManagerAdmin;
  }

  // Silence unused-param warning while keeping the hint available for future
  // logging extensions.
  void selfSaIdHint;
  return base;
}

async function main(): Promise<void> {
  const env = parseEnvFile(ENV_PATH);
  const folderId = env.get(PROD_FOLDER_ID_VAR);
  if (!folderId) {
    console.error(`ERROR: ${PROD_FOLDER_ID_VAR} not set in .env.yandex`);
    process.exit(2);
  }

  const prodKey = env.get("YANDEX_SA_KEY_JSON");
  const testKey = env.get("YANDEX_TEST_SA_KEY_JSON");

  const [prodResult, testResult] = await Promise.all([
    introspectSa("PROD", "YANDEX_SA_KEY_JSON", prodKey, folderId, null),
    introspectSa("TEST", "YANDEX_TEST_SA_KEY_JSON", testKey, folderId, null),
  ]);

  const report = {
    folderId,
    timestamp: new Date().toISOString(),
    results: [prodResult, testResult],
  };

  // Sanitize: remove any private_key smuggled into error strings (defensive).
  const sanitized = JSON.parse(
    JSON.stringify(report).replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, "<REDACTED-KEY>"),
  );
  // Use stdout (not console.log to keep the redaction-only output clean).
  process.stdout.write(JSON.stringify(sanitized, null, 2) + "\n");

  const anyOk = report.results.some((r) => r.iamTokenStatus === "ok");
  process.exit(anyOk ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", (err as Error).message);
  process.exit(3);
});
