# OAuth-Local Smoke Runbook

**Status**: live as of 2026-05-19. Covers running the Decepticon stack
on a developer Mac using a Claude Max/Pro OAuth subscription (no
`ANTHROPIC_API_KEY` consumed). Production VPS dispatch is a separate
runbook ([[smoke-2026-05-19]]).

---

## 0. Prerequisites

- macOS 13+ (Darwin 24.6.0 verified).
- Docker Desktop running with ≥8 GiB allocated.
- `bun` 1.x on `PATH`.
- A valid Claude Code login in the keychain (`Claude Code-credentials`
  entry should exist). Run `claude /login` once if not.
- Repo cloned and on `001-backend-v2` (or later).

Verify:
```bash
security find-generic-password -s "Claude Code-credentials" -w | head -c 32
# expect: {"claudeAiOauth":{"accessTo
```

---

## 1. Materialize the OAuth credentials file

On a fresh machine `~/.claude/.credentials.json` may be **missing or an
empty directory**. The Decepticon container expects a JSON file. Use:

```bash
./scripts/extract-claude-creds.sh --force
# wrote /Users/<you>/.claude/.credentials.json
# token prefix: sk-ant-oat01-…  (OAuth)
# perms: -rw-------
```

The script is idempotent — safe to re-run if the token has been
refreshed.

---

## 2. Configure Decepticon `.env`

Create or overwrite `external/decepticon/.env` so it has:

```env
# REQUIRED for OAuth path
CLAUDE_CREDENTIALS_VOLUME=/Users/<you>/.claude/.credentials.json
DECEPTICON_MODEL_PROFILE=eco          # eco | max | test
DECEPTICON_MODEL_PROVIDER=auth        # *** the critical switch ***
DECEPTICON_AUTH_CLAUDE_CODE=true
DECEPTICON_AUTH_PRIORITY=anthropic_oauth

# Internal LiteLLM (unchanged from .env.example)
LITELLM_MASTER_KEY=sk-decepticon-master
LITELLM_SALT_KEY=sk-decepticon-salt-change-me
POSTGRES_PASSWORD=decepticon
NEO4J_PASSWORD=decepticon-graph

# Placeholders — leave as literal "your-…-key-here" so the wizard
# disables the matching API methods
ANTHROPIC_API_KEY=your-anthropic-api-key-here
OPENAI_API_KEY=your-openai-key-here
GEMINI_API_KEY=your-gemini-key-here
MINIMAX_API_KEY=your-minimax-key-here

LANGSMITH_TRACING=false
LANGSMITH_API_KEY=your-langsmith-key-here
LANGSMITH_PROJECT=decepticon
COMPOSE_PROFILES=c2-sliver
```

> **Important**: `DECEPTICON_MODEL_PROVIDER=auth` is what flips the
> in-container `LLMModelMapping.with_provider("auth")` so every primary
> resolves to `auth/claude-*` instead of `anthropic/claude-*`. Without
> this var the agent calls the OpenRouter-hijacked `anthropic/*` routes
> and burns OpenRouter credits.

---

## 3. Add the missing `auth/claude-opus-4-6` route to `litellm.yaml`

The currently shipped `decepticon-langgraph` image hardcodes
`OPUS = "anthropic/claude-opus-4-6"`, which `with_provider("auth")`
remaps to `auth/claude-opus-4-6`. The default `external/decepticon/
config/litellm.yaml` only wires `auth/claude-opus-4-7`. Add this alias
block (already present in this branch — confirm with grep):

```yaml
  # [TENSOL 2026-05-19] image-baked OPUS=4-6 alias → 4-7
  - model_name: auth/claude-opus-4-6
    litellm_params:
      model: auth/claude-opus-4-7
      additional_drop_params: ["temperature"]
```

And to the `fallbacks:` block:

```yaml
    - {"auth/claude-opus-4-6": ["auth/claude-sonnet-4-6"]}
```

Verify:
```bash
grep -n "auth/claude-opus-4-6" external/decepticon/config/litellm.yaml
```

---

## 4. Bring up the stack

```bash
open -a Docker                    # ensure daemon
cd external/decepticon
docker compose up -d
docker compose ps                 # all 7 services healthy
```

First-run wall-clock: ~5 min (pulls images + Postgres init).

---

## 5. Smoke the OAuth path through LiteLLM

```bash
for MODEL in auth/claude-haiku-4-5 auth/claude-sonnet-4-6 auth/claude-opus-4-6; do
  echo "=== $MODEL ==="
  curl -sS http://localhost:4000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer sk-decepticon-master" \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"reply ok\"}],\"max_tokens\":16}" \
    | python3 -m json.tool
done
```

Expect: each returns HTTP 200 + a non-empty `choices[0].message.content`
with a `model: auth/claude-…` echo and a native Anthropic `msg_01…` id.

If you see `OpenrouterException 402` → `DECEPTICON_MODEL_PROVIDER=auth`
is **not** being read; restart langgraph + litellm:
```bash
docker compose up -d --force-recreate langgraph litellm
```

---

## 6. Run a recon-only Decepticon scan

```bash
# Create a thread
THREAD_ID=$(curl -sS -X POST http://localhost:2024/threads \
  -H 'Content-Type: application/json' -d '{}' \
  | jq -r '.thread_id')

# Stream a recon-only run against scanme.nmap.org
curl -sN -X POST "http://localhost:2024/threads/${THREAD_ID}/runs/stream" \
  -H 'Content-Type: application/json' \
  -d '{
    "assistant_id": "d18311c3-263f-5ee8-ab45-fe337084e45e",
    "input": {
      "messages": [{
        "role":"user",
        "content":"Recon scanme.nmap.org. Write 1 finding to /workspace/findings/."
      }]
    },
    "config":{"recursion_limit": 50}
  }' | tee recon.log
```

Expected outcome:
- `docker logs decepticon-litellm | grep -c "POST .*chat/completions.* 200 OK"`
  steadily increases.
- `docker exec decepticon-sandbox ls /workspace/findings/*.md` lists ≥1
  markdown finding with YAML frontmatter.

> **Production gap**: `/workspace` is **not** reset between scans. If
> you re-run, stash the prior artifacts:
> ```bash
> docker exec decepticon-sandbox sh -c \
>   'mv /workspace/findings /workspace/findings.stale-$(date +%s) && mkdir -p /workspace/findings && chmod 777 /workspace/findings'
> ```

---

## 7. Full orchestrator (HITL → pre-approved)

`assistant_id b4beb031-4e87-5408-99e1-66c7ab19cfeb` is the `decepticon`
orchestrator. By default it presents an OPPLAN proposal and waits for a
human reply. Inject the pre-approval directive in the prompt itself:

```
INSTRUCTION: This OPPLAN is pre-approved. Begin execution immediately.
Do NOT wait for human approval. Do NOT present the OPPLAN for review.
Start dispatching agents now.
```

Bump `recursion_limit` to ≥80 for multi-agent workflows; full scan ~5-30
min on Max subscription with `eco` profile.

---

## 8. Token refresh

The OAuth token in the bind-mounted file carries an `expiresAt` (ms
unix). `claude_code_handler.py` auto-refreshes on 401 via
`oauth_refresh_request` and writes the new token back via
`write_json_atomic` into the same file (which is bind-mounted, so the
host sees the refreshed token).

If you remount stale creds before the refresh window closes, you'll
hit 401s — re-run `scripts/extract-claude-creds.sh` to pull the latest
keychain blob.

---

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| `OpenrouterException 402 "more credits"` | `DECEPTICON_MODEL_PROVIDER` not set to `auth` | Edit `.env`, recreate langgraph |
| `Vertex_ai_betaException 400 API key invalid` | Fallback cascade reached unkeyed Vertex; root cause is upstream OAuth not engaged | Same as above |
| Agent loops 25 steps then `GraphRecursionError` | Default `recursion_limit` too low | Add `"config":{"recursion_limit": 50}` to the stream POST body |
| `auth/claude-opus-4-* not found` | litellm.yaml missing alias for image-baked OPUS=4-6 | Add the alias block in §3 |
| `~/.claude/.credentials.json: not a regular file` | The path is an empty directory | `./scripts/extract-claude-creds.sh --force` |

---

## What this runbook does NOT cover

- Tensol backend `POST /v1/scans` dispatch — that's Phase C of the
  `/goal decepticon-oauth-local-smoke` loop and is not yet implemented.
- Production VPS spawn — see [[smoke-2026-05-19]] for the T102 resume
  checklist.
