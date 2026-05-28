#!/usr/bin/env bun
/**
 * Tensol /contact Telegram relay.
 *
 * Tiny Bun HTTP server that accepts a JSON lead payload on POST /api/contact
 * and forwards it to a Telegram chat via the bot API. Designed to run on a
 * VPS, Yandex Cloud Function, or similar edge-runtime.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  required — `123456:ABC...`
 *   TELEGRAM_CHAT_ID    required — numeric chat or channel id
 *   PORT                default 8787
 *   ALLOWED_ORIGIN      default "*" — comma-separated allow-list
 */

const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
const TELEGRAM_CHAT_ID = process.env['TELEGRAM_CHAT_ID'];
const PORT = Number(process.env['PORT'] ?? 8787);
const ALLOWED_ORIGIN = (process.env['ALLOWED_ORIGIN'] ?? '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  // eslint-disable-next-line no-console
  console.error('[telegram-relay] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

type Lead = {
  name: string;
  telegram: string;
  phone: string;
  consent?: boolean;
};

const TELEGRAM_HANDLE_RE = /^[A-Za-z0-9_]{4,32}$/;

const normalizeTelegram = (raw: string): string => {
  let v = raw.trim();
  v = v.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '');
  if (v.startsWith('@')) v = v.slice(1);
  return v;
};

const phoneDigits = (raw: string): string => raw.replace(/\D/g, '');

const isLead = (v: unknown): v is Lead => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o['name'] !== 'string' || o['name'].trim().length === 0) return false;
  if (typeof o['telegram'] !== 'string') return false;
  if (!TELEGRAM_HANDLE_RE.test(normalizeTelegram(o['telegram']))) return false;
  if (typeof o['phone'] !== 'string') return false;
  const digits = phoneDigits(o['phone']);
  if (digits.length < 10 || digits.length > 15) return false;
  return true;
};

const escapeMd = (s: string): string => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);

const formatMessage = (lead: Lead): string => {
  const tg = normalizeTelegram(lead.telegram);
  const safeName = escapeMd(lead.name);
  const safeTg = escapeMd(tg);
  const safePhone = escapeMd(lead.phone);
  return [
    '*🐎 Tensol — new lead*',
    '',
    `*${safeName}*`,
    `✈️ [@${safeTg}](https://t.me/${tg})`,
    `📞 ${safePhone}`,
    '',
    `_submitted ${escapeMd(new Date().toISOString())}_`,
  ].join('\n');
};

const corsHeaders = (origin: string | null): Record<string, string> => {
  const allow = ALLOWED_ORIGIN.includes('*')
    ? '*'
    : origin && ALLOWED_ORIGIN.includes(origin)
      ? origin
      : ALLOWED_ORIGIN[0] ?? '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
};

const json = (
  status: number,
  body: unknown,
  origin: string | null,
  extra: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin), ...extra },
  });

const sendToTelegram = async (text: string): Promise<{ ok: boolean; status: number }> => {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  });
  return { ok: res.ok, status: res.status };
};

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');

    if (url.pathname === '/api/contact') {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      if (req.method !== 'POST') {
        return json(405, { ok: false, error: 'method_not_allowed' }, origin);
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { ok: false, error: 'invalid_json' }, origin);
      }
      if (!isLead(body)) {
        return json(400, { ok: false, error: 'invalid_payload' }, origin);
      }
      try {
        const result = await sendToTelegram(formatMessage(body));
        if (!result.ok) {
          return json(502, { ok: false, error: 'telegram_failed' }, origin);
        }
        return json(200, { ok: true }, origin);
      } catch {
        return json(502, { ok: false, error: 'telegram_unreachable' }, origin);
      }
    }

    if (url.pathname === '/healthz') {
      return json(200, { ok: true, ts: new Date().toISOString() }, origin);
    }

    return json(404, { ok: false, error: 'not_found' }, origin);
  },
});

// eslint-disable-next-line no-console
console.log(`[telegram-relay] listening on http://localhost:${server.port}`);
