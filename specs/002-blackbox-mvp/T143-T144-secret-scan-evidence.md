# T143 + T144 — Secret-Scan & .env.example Verification Evidence

Date: 2026-05-20
Branch: `002-blackbox-mvp`

## T143 — Secret scan of committed tree

### Command

```bash
bash scripts/check-no-secrets.sh
```

Internally:

```bash
git grep -nE 'sk-ant-|sk-or-|sk-proj-|sk_live_|sk_test_|AKIA[A-Z0-9]{16}' -- $(git ls-files)
```

### Result

```
OK: no secrets in committed tree (outside fixtures/docs/tests)
```

Exit code: `0`.

### Raw hits (all allow-listed)

| Path                                          | Reason allowed                                  |
| --------------------------------------------- | ----------------------------------------------- |
| `docs/research/decepticon-dossier.md`         | `docs/` — provider docs, prefix mention only    |
| `scripts/extract-claude-creds.sh:56,57,92`    | OAuth token-shape validator (compares prefix)   |
| `server/src/deep-inquiries/sanitize.test.ts`  | `*.test.ts` — synthetic redaction inputs        |
| `server/src/deep-inquiries/sanitize.ts:69,72,76` | Redaction regex source (literal pattern needed) |
| `specs/001-backend-v2/oauth-local-runbook.md` | `specs/` — OAuth runbook prefix doc             |

### Allow-list predicates (in `check-no-secrets.sh`)

- Path segments: `/tests/`, `/test/`, `/fixtures/`, `/specs/`, `/docs/`, `/e2e/helpers/`
- Root prefixes: `tests/`, `test/`, `fixtures/`, `specs/`, `docs/`
- Suffixes: `*.test.ts`, `*.test.tsx`, `*.test.js`
- README files
- Explicit files: `sanitize.ts` (redaction regex), `extract-claude-creds.sh` (OAuth token validator)

No real-secret matches surfaced.

## T144 — `server/.env.example` placeholder verification

### Source

`server/.env.example` @ commit `fb35355` (current HEAD path).

### Per-line audit

| Line | Key                              | Value (verbatim)                              | Verdict     | Notes                                   |
| ---- | -------------------------------- | --------------------------------------------- | ----------- | --------------------------------------- |
| 8    | `TENSOL_DB_URL`                  | `file:./data/tensol.db`                       | placeholder | local file path, no secret              |
| 9    | `TENSOL_PORT`                    | `3000`                                        | placeholder | port number                             |
| 10   | `TENSOL_HMAC_SECRET`             | `replace_with_32_byte_hex`                    | placeholder | explicit replace-me                     |
| 14   | `TENSOL_TELEGRAM_BOT_TOKEN`      | `7**********:AAH**********`                   | shape-hint  | masked example with `*` runs            |
| 16   | `TENSOL_TELEGRAM_CHAT_ID`        | `000000000`                                   | placeholder | all-zero numeric                        |
| 18   | `TENSOL_TELEGRAM_BOT_USERNAME`   | `tensol_leadsbot`                             | public      | public bot handle, not secret           |
| 21   | `TENSOL_TELEGRAM_WEBHOOK_SECRET` | `replace_with_32_byte_hex`                    | placeholder | explicit replace-me                     |
| 23   | `TENSOL_TELEGRAM_LONGPOLL`       | `false`                                       | bool        | feature flag                            |
| 27   | `YANDEX_SA_KEY_JSON`             | `JSON_KEY_BASE64_OR_PATH`                     | placeholder | explicit format hint                    |
| 29   | `YANDEX_PROD_FOLDER_ID`          | `b1g*****************`                        | shape-hint  | masked Yandex ID                        |
| 30   | `YANDEX_PROD_NETWORK_ID`         | `enp*****************`                        | shape-hint  | masked Yandex ID                        |
| 31   | `YANDEX_PROD_SUBNET_ID`          | `e9b*****************`                        | shape-hint  | masked Yandex ID                        |
| 33   | `YANDEX_PROD_SSH_PUBLIC_KEY`     | `ssh-ed25519 AAAA... tensol-prod`             | shape-hint  | truncated public key — public material  |
| 37   | `TENSOL_YOOKASSA_LIVE`           | `live_replace_with_yookassa_secret`           | placeholder | explicit replace-me                     |
| 41   | `TENSOL_EVIDENCE_BUCKET`         | `tensol-evidence-prod`                        | public name | bucket name, not a credential           |
| 45   | `TENSOL_WEBHOOK_SECRET`          | `replace_with_32_byte_hex`                    | placeholder | explicit replace-me                     |
| 52   | `TENSOL_OPERATOR_EMAILS`         | `op1@tensol.com,op2@tensol.com`               | placeholder | example email tuple                     |
| 56   | `TENSOL_DEV_DNS_BYPASS`          | `false`                                       | bool        | feature flag                            |

### Verdict

All 18 settings carry placeholder/shape-hint/public-only values. **Zero real-secret leaks**.

## Conclusion

- T143: PASS — `scripts/check-no-secrets.sh` runs clean; CI-wireable.
- T144: PASS — `server/.env.example` is placeholder-only.
