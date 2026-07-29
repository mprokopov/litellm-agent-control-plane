// Pi Agent Core exposed through the Anthropic Managed Agents API spec, so LAP
// can register it as a `claude_managed_agents` runtime.
//
//   LAP -> pi-agent-server :8080 -> (in-process Pi agent loop) -> LAP /v1/messages
//
// Model calls are routed back through LAP by default, so LAP sees the spend and
// no provider key is needed here beyond the gateway key.

import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import express from "express";

import {
  agentResponse,
  errorEvent,
  modelId,
  partsFromEvents,
  sessionResponse,
  translatePiEvent,
} from "./anthropic.mjs";
import { fetchLiteLlmModels, modelListFromValue } from "./model-list.mjs";
import { createSessionRegistry, resolveStreamFn } from "./pi-agent.mjs";
import { createStore } from "./store.mjs";

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || "/data/agents.db";
const WORKDIR = process.env.WORKDIR || "/tmp/pi-workspace";
const RUNTIME_API_KEY = process.env.RUNTIME_API_KEY || "";

// LITELLM_BASE_URL keeps the OpenAI-style `/v1` suffix for consistency with the
// other templates (model discovery hits `{base}/models`). pi-agent.mjs strips
// the suffix before handing it to pi-ai, which appends provider paths itself.
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL || "";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || "";
const PI_MODEL_API = process.env.PI_MODEL_API || "anthropic-messages";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "";
const LITELLM_MODELS = (process.env.LITELLM_MODELS || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const CONTEXT_WINDOW = Number(process.env.PI_CONTEXT_WINDOW || 200_000);
const MAX_TOKENS = Number(process.env.PI_MAX_TOKENS || 8192);

if (!LITELLM_BASE_URL || !LITELLM_API_KEY) {
  console.error(
    "[boot] LITELLM_BASE_URL and LITELLM_API_KEY are required (point them at LAP, e.g. http://lap:4000/v1)",
  );
  process.exit(1);
}

await mkdir(WORKDIR, { recursive: true });
const store = createStore(DB_PATH);

const streamFn = await resolveStreamFn(PI_MODEL_API);
const config = {
  baseUrl: LITELLM_BASE_URL,
  apiKey: LITELLM_API_KEY,
  api: PI_MODEL_API,
  workdir: WORKDIR,
  defaultModel: DEFAULT_MODEL || LITELLM_MODELS[0] || "",
  contextWindow: CONTEXT_WINDOW,
  maxTokens: MAX_TOKENS,
  streamFn,
};

const registry = createSessionRegistry({ store, config });

console.log(
  `[boot] pi runtime -> ${LITELLM_BASE_URL} (api: ${PI_MODEL_API}, models: ${
    LITELLM_MODELS.join(", ") || config.defaultModel || "(discovered)"
  })`,
);

const app = express();
app.use(express.json({ limit: "25mb" }));

/** Wrap an async handler so rejections become 500s instead of hanging. */
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`[pi] ${req.method} ${req.path} failed:`, err?.message ?? err);
    if (!res.headersSent) res.status(500).json({ error: err?.message ?? "internal error" });
  });

// Bearer auth for every route except /health, so LAP's registration probe can
// reach it before credentials are wired.
app.use((req, res, next) => {
  if (!RUNTIME_API_KEY || req.path === "/health") return next();
  const header = req.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "");
  const apiKey = req.get("x-api-key") || "";
  if (bearer === RUNTIME_API_KEY || apiKey === RUNTIME_API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// 4.1 Health check --------------------------------------------------------
// Pi runs in-process, so there is no child to probe: if this handler answers,
// the harness is available.
app.get("/health", (_req, res) => {
  res.json({ ok: true, pi: true, sessions: registry.size() });
});

// 4.2 Model discovery -----------------------------------------------------
function localModelFallback() {
  const ids = LITELLM_MODELS.length
    ? LITELLM_MODELS
    : [config.defaultModel].filter(Boolean);
  return modelListFromValue({ data: ids.map((id) => ({ id })) }, "pi") || { object: "list", data: [] };
}

app.get(
  "/v1/models",
  wrap(async (_req, res) => {
    try {
      const models = await fetchLiteLlmModels({
        baseURL: LITELLM_BASE_URL,
        apiKey: LITELLM_API_KEY,
        ownedBy: "pi",
      });
      // Keep the configured allow-list authoritative when one is set.
      if (LITELLM_MODELS.length) {
        const allowed = new Set(LITELLM_MODELS);
        const filtered = models.data.filter((m) => allowed.has(m.id));
        if (filtered.length) return res.json({ object: "list", data: filtered });
      }
      return res.json(models);
    } catch (err) {
      // Never 5xx here: LAP surfaces a 502 in the agent builder if discovery fails.
      console.warn("[pi] model discovery failed, using local fallback:", err?.message ?? err);
      return res.json(localModelFallback());
    }
  }),
);

// 4.3–4.6 Agent CRUD ------------------------------------------------------
app.post(
  "/v1/agents",
  wrap(async (req, res) => {
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: "name is required" });
    // The copied store has no description/tools columns, so carry LAP's extra
    // agent metadata inside `permissions` (see agentResponse).
    const permissions = {
      ...(body.permissions || {}),
      ...(body.tools !== undefined ? { tools: body.tools } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    };
    const row = store.createAgent({
      name: body.name,
      system: body.system || body.prompt || "",
      model: modelId(body.model) || config.defaultModel,
      permissions,
      mcp_servers: body.mcp_servers || [],
    });
    // No runtime reboot needed: the next session picks the row up directly.
    res.json(agentResponse(row));
  }),
);

app.get(
  "/v1/agents",
  wrap(async (_req, res) => {
    res.json({ data: store.listAgents().map(agentResponse) });
  }),
);

app.get(
  "/v1/agents/:id",
  wrap(async (req, res) => {
    const row = store.getAgent(req.params.id);
    if (!row) return res.status(404).json({ error: "agent not found" });
    res.json(agentResponse(row));
  }),
);

app.patch(
  "/v1/agents/:id",
  wrap(async (req, res) => {
    const existing = store.getAgent(req.params.id);
    if (!existing) return res.status(404).json({ error: "agent not found" });
    const body = req.body || {};
    const patch = {};
    if ("name" in body) patch.name = body.name;
    if ("system" in body) patch.system = body.system;
    if ("model" in body) patch.model = modelId(body.model);
    if ("mcp_servers" in body) patch.mcp_servers = body.mcp_servers;
    if ("permissions" in body || "tools" in body || "description" in body) {
      patch.permissions = {
        ...(existing.permissions || {}),
        ...(body.permissions || {}),
        ...(body.tools !== undefined ? { tools: body.tools } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      };
    }
    const row = store.updateAgent(req.params.id, patch);
    if (!row) return res.status(404).json({ error: "agent not found" });
    res.json(agentResponse(row));
  }),
);

// 4.7 Create environment --------------------------------------------------
// Workspace configs are advisory for this template: the agent always runs in
// WORKDIR. Accept and echo them so the LAP flow completes.
const environments = new Map();
app.post(
  "/v1/environments",
  wrap(async (req, res) => {
    const id = `env_${crypto.randomBytes(8).toString("hex")}`;
    const env = { id, type: "environment", name: req.body?.name ?? null, config: req.body?.config ?? {} };
    environments.set(id, env);
    res.json(env);
  }),
);

// 4.8 Create session ------------------------------------------------------
app.post(
  "/v1/sessions",
  wrap(async (req, res) => {
    const agentRef = req.body?.agent ?? req.body?.agent_id;
    const row = agentRef ? store.getAgent(agentRef) : null;
    if (!row) return res.status(400).json({ error: "unknown agent" });

    const sessionId = `ses_${crypto.randomBytes(12).toString("hex")}`;
    await registry.createSession(sessionId, row, translatePiEvent);
    res.json(
      sessionResponse({
        id: sessionId,
        agentId: row.id,
        environmentId: req.body?.environment_id,
      }),
    );
  }),
);

// 4.9 Send events (prompt) ------------------------------------------------
app.post(
  "/v1/sessions/:id/events",
  wrap(async (req, res) => {
    const parts = partsFromEvents(req.body?.events || []);
    if (!parts.length) return res.status(400).json({ error: "no user.message parts" });
    if (!registry.get(req.params.id)) return res.status(404).json({ error: "unknown session" });

    const text = parts.map((p) => p.text).join("\n");
    registry.prompt(req.params.id, text, (message) => {
      registry.broadcast(req.params.id, errorEvent(message));
      registry.broadcast(req.params.id, {
        event: "session.status_idle",
        data: { stop_reason: { type: "error" } },
      });
    });
    res.status(202).json({ ok: true });
  }),
);

// 4.10 Abort session ------------------------------------------------------
app.post(
  "/v1/sessions/:id/abort",
  wrap(async (req, res) => {
    res.json({ aborted: registry.abort(req.params.id) });
  }),
);

// 4.11 Historical events --------------------------------------------------
// Implemented for real rather than stubbed: every broadcast event is persisted
// to SQLite, so a client can replay a completed run.
app.get(
  "/v1/sessions/:id/events",
  wrap(async (req, res) => {
    res.json({ data: store.listSessionEvents(req.params.id) });
  }),
);

// 4.12 Live event stream --------------------------------------------------
app.get(
  "/v1/sessions/:id/events/stream",
  wrap(async (req, res) => {
    const sessionId = req.params.id;
    if (!registry.get(sessionId)) return res.status(404).json({ error: "unknown session" });

    res.set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    const write = ({ event, data }) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay what already happened so a late subscriber sees the whole run,
    // then stream live. Pi may finish a short turn before LAP attaches.
    for (const past of store.listSessionEvents(sessionId)) {
      const { seq, ...rest } = past;
      write(rest);
    }

    const detach = registry.attach(sessionId, write);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      detach();
      res.end();
    });
  }),
);

app.delete(
  "/v1/sessions/:id",
  wrap(async (req, res) => {
    registry.remove(req.params.id);
    res.json({ deleted: true });
  }),
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] pi agent server listening on :${PORT}`);
});
