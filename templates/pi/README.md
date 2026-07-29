# Pi Managed Agents server

Runs [Pi Agent Core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
behind the Anthropic Managed Agents API so LiteLLM Agent Platform (LAP) can use
it as a `claude_managed_agents` runtime.

```text
LAP -> pi-agent-server :8080 -> (in-process Pi agent loop) -> LAP /v1/messages -> your gateway
```

**Pi is a library, not a CLI.** Unlike the `opencode` and `openclaw` templates,
this server does not spawn a child runtime process, so there is no runtime
health probe, no reboot-on-agent-create, and no generated on-disk runtime
config. Creating an agent writes a SQLite row; a session constructs an `Agent`
in-process.

## Quick Start

### Run with Docker

```bash
cd templates/pi
docker build -t pi-agent-server .
docker run --rm -p 8080:8080 \
  -v pi-agent-data:/data \
  -e LITELLM_BASE_URL=http://host.docker.internal:4000/v1 \
  -e LITELLM_API_KEY=sk-local \
  -e LITELLM_MODELS=gemini-2.5-flash \
  -e DEFAULT_MODEL=gemini-2.5-flash \
  pi-agent-server
```

Health check:

```bash
curl http://localhost:8080/health
# {"ok":true,"pi":true,"sessions":0}
```

### Register with LAP

```bash
curl -X POST http://localhost:4000/api/runtime-harnesses \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"alias":"local-pi","api_spec":"claude_managed_agents",
       "api_base":"http://pi:8080","api_key":"local-pi-key"}'
```

## Environment

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LITELLM_BASE_URL` | yes | — | Gateway base **with** `/v1` (e.g. `http://lap:4000/v1`). Used verbatim for model discovery; the `/v1` suffix is stripped before it reaches pi-ai. |
| `LITELLM_API_KEY` | yes | — | Gateway key, sent for every model call. |
| `PI_MODEL_API` | no | `anthropic-messages` | pi-ai wire API: `anthropic-messages`, `openai-completions`, or `openai-responses`. |
| `DEFAULT_MODEL` | no | first of `LITELLM_MODELS` | Model for agents created without one. |
| `LITELLM_MODELS` | no | — | Comma-separated allow-list. When set, `/v1/models` is filtered to it. |
| `RUNTIME_API_KEY` | no | — | When set, all routes except `/health` require this as bearer or `x-api-key`. |
| `PORT` | no | `8080` | Listen port. |
| `WORKDIR` | no | `/tmp/pi-workspace` | Agent workspace; tools cannot escape it. |
| `DB_PATH` | no | `/data/agents.db` | SQLite path for agents, session bindings, and event history. |
| `PI_CONTEXT_WINDOW` | no | `200000` | Reported context window. |
| `PI_MAX_TOKENS` | no | `8192` | Max output tokens per turn. |
| `BASH_TIMEOUT_MS` | no | `120000` | Timeout for the `bash` tool. |

### Choosing `PI_MODEL_API`

Default to `anthropic-messages` when pointing at LAP: LAP serves `/v1/messages`
and `/v1/responses` but **not** `/v1/chat/completions` — a POST there hits LAP's
UI static-file fallback and returns `405`. Use `openai-completions` only when
pointing directly at a gateway that serves chat completions.

`LITELLM_BASE_URL` must not be doubled up: pi-ai appends the provider path
itself, so `http://lap:4000/v1` becomes `http://lap:4000/v1/messages`. This
template strips a trailing `/v1` for that reason.

## Tools

`bash`, `read`, `write`, `edit`, `glob`, `grep` — ids match LAP's agent builder,
so the UI checkboxes map 1:1. An agent created without a tool selection gets all
six. File tools are confined to `WORKDIR`.

> **Security**: the `bash` tool runs model-authored commands through a shell by
> design, so the isolation boundary is the container — not argument escaping.
> Run this image without ambient cloud credentials, and omit `bash` from the
> tool selection for untrusted prompts.

## Implemented API

| Route | Notes |
|-------|-------|
| `GET /health` | `{ok, pi, sessions}` |
| `GET /v1/models` | Proxies `{LITELLM_BASE_URL}/models`, falls back to `LITELLM_MODELS` locally; never 5xx |
| `POST/GET /v1/agents`, `GET/PATCH /v1/agents/:id` | SQLite-backed; no reboot needed |
| `POST /v1/environments` | Accepted and echoed; the agent always runs in `WORKDIR` |
| `POST /v1/sessions` | Builds an in-process `Agent` for the bound agent row |
| `POST /v1/sessions/:id/events` | Fire-and-forget prompt, returns `202` |
| `POST /v1/sessions/:id/abort` | Calls `agent.abort()` |
| `GET /v1/sessions/:id/events` | **Real** history from SQLite, not a stub |
| `GET /v1/sessions/:id/events/stream` | SSE; replays history then streams live |
| `DELETE /v1/sessions/:id` | Aborts and unbinds |

### Streaming detail

Pi's `message_update` carries the **full** partial message, not a delta, while
the Anthropic spec expects `agent.message` to be incremental. The translation
layer tracks a per-run watermark and emits only the new suffix; without it a
client renders the reply repeatedly with growing prefixes.

## Smoke test

```bash
./scripts/smoke.sh http://localhost:8080 gemini-2.5-flash
```
