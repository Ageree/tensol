import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function digestHex(message: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function parseSignature(raw: string | null) {
  if (!raw) return null;
  const parts = Object.fromEntries(raw.split(",").map((p) => {
    const [k, ...rest] = p.trim().split("=");
    return [k, rest.join("=")];
  }));
  const t = Number.parseInt(parts.t ?? "", 10);
  const v1 = parts.v1 ?? "";
  if (!Number.isFinite(t) || !/^[0-9a-f]+$/i.test(v1)) return null;
  return { t, v1: v1.toLowerCase() };
}

const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
type Severity = (typeof SEVERITIES)[number];
const CONFIDENCES = ["verified", "high", "medium", "low"] as const;
type Confidence = (typeof CONFIDENCES)[number];

function severity(value: unknown): Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
    ? (value as Severity)
    : "medium";
}

function confidence(value: unknown): Confidence {
  return typeof value === "string" && (CONFIDENCES as readonly string[]).includes(value)
    ? (value as Confidence)
    : "high";
}

http.route({
  path: "/v1/webhooks/scan-complete",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const rawBody = await req.text();
    let body: {
      scan_id?: string;
      scan_order_id?: string;
      delivery_id?: string;
      event_id?: string;
      id?: string;
      findings?: Array<Record<string, unknown>>;
      usage?: { tokens?: number; usd_cents?: number };
    };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return Response.json({ error: "webhook_body_invalid", message: "invalid JSON" }, { status: 422 });
    }
    if (!body.scan_id) {
      return Response.json({ error: "webhook_body_invalid", message: "scan_id required" }, { status: 422 });
    }

    const sig = parseSignature(req.headers.get("x-tensol-signature"));
    if (!sig) {
      return Response.json({ error: "webhook_invalid_signature", message: "missing per-scan signature" }, { status: 401 });
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - sig.t) > 5 * 60) {
      return Response.json({ error: "webhook_replay_too_old", message: "signature timestamp outside replay window" }, { status: 401 });
    }
    const material = await ctx.runQuery(internal.ops.getWebhookVerificationMaterial, {
      scanId: body.scan_id as never,
    });
    const expected = await hmacHex(material.signKey, `${sig.t}.${rawBody}`);
    if (!safeEqual(expected, sig.v1)) {
      return Response.json({ error: "webhook_invalid_signature", message: "per-scan signature mismatch" }, { status: 401 });
    }

    const fleetSecret = process.env.WEBHOOK_SECRET;
    const fleetSig = parseSignature(req.headers.get("x-tensol-fleet-signature"));
    if (fleetSecret && fleetSig) {
      const fleetExpected = await hmacHex(fleetSecret, `${fleetSig.t}.${rawBody}`);
      if (
        Math.abs(nowSeconds - fleetSig.t) > 5 * 60 ||
        !safeEqual(fleetExpected, fleetSig.v1)
      ) {
        return Response.json({ error: "webhook_invalid_signature", message: "fleet signature mismatch" }, { status: 401 });
      }
    }

    const dedupKey =
      body.delivery_id ?? body.event_id ?? body.id ?? `${body.scan_id}:${await digestHex(rawBody)}`;
    const result = await ctx.runMutation(internal.ops.completeScan, {
      scanId: body.scan_id as never,
      findings: (body.findings ?? []).map((f, i) => ({
        external_id: typeof f.external_id === "string" ? f.external_id : `agent-${i + 1}`,
        severity: severity(f.severity),
        title: typeof f.title === "string" ? f.title : "Agent finding",
        target: typeof f.target === "string" ? f.target : undefined,
        body_md: typeof f.body_md === "string" ? f.body_md : typeof f.body === "string" ? f.body : undefined,
        evidence_keys: Array.isArray(f.evidence_keys) ? (f.evidence_keys as string[]) : [],
        cwe: Array.isArray(f.cwe) ? (f.cwe as string[]) : [],
        mitre: Array.isArray(f.mitre) ? (f.mitre as string[]) : [],
        confidence: confidence(f.confidence),
      })),
      usageTokens: body.usage?.tokens,
      usageUsdCents: body.usage?.usd_cents,
      dedupKey,
    });
    if (result.status === "completed") {
      await ctx.runAction(internal.gcloud.teardownScanVm, { scanId: body.scan_id as never });
    }
    return Response.json({ status: result.status }, { status: 200 });
  }),
});

export default http;
