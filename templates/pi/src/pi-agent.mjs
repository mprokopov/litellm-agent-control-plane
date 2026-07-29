// Pi Agent Core lifecycle for the LAP runtime template.
//
// Unlike the opencode/openclaw templates there is NO child process: Pi is a
// library, so the agent loop runs inside this server. That removes the
// spawn/health-probe/reboot-on-agent-create machinery those templates need —
// creating an agent is just a SQLite row, and a session is an in-process Agent.

import { Agent } from "@earendil-works/pi-agent-core";
import { selectTools, toolIdsFrom } from "./tools.mjs";

// pi-ai ships one module per wire API under the ./api/* subpath, each exporting
// exactly {stream, streamSimple}. These are NOT re-exported from the package
// root (importing `streamSimpleAnthropic` from "@earendil-works/pi-ai" yields
// undefined), so they must be loaded by subpath.
const API_MODULES = {
  "anthropic-messages": () => import("@earendil-works/pi-ai/api/anthropic-messages"),
  "openai-completions": () => import("@earendil-works/pi-ai/api/openai-completions"),
  "openai-responses": () => import("@earendil-works/pi-ai/api/openai-responses"),
};

/**
 * Build the Pi `Model` descriptor for a model id.
 *
 * `baseUrl` must NOT carry a `/v1` suffix: pi-ai appends the full provider path
 * (e.g. `/v1/messages`) itself. LAP's own `api_base` follows the same rule, and
 * a doubled `/v1/v1/messages` lands on LAP's UI static-file fallback, which
 * answers POST with 405.
 */
export function buildModel(id, { baseUrl, api, contextWindow, maxTokens }) {
  return {
    id,
    name: id,
    api,
    // The provider id only selects credential/env conventions; the actual
    // endpoint is baseUrl, which points at LAP.
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, ""),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

/** Resolve the StreamFn for a wire API, loading the pi-ai module lazily. */
export async function resolveStreamFn(api) {
  const load = API_MODULES[api];
  if (!load) {
    throw new Error(
      `unsupported PI_MODEL_API: ${api} (expected one of ${Object.keys(API_MODULES).join(", ")})`,
    );
  }
  const mod = await load();
  if (typeof mod.streamSimple !== "function") {
    throw new Error(`pi-ai api module ${api} does not export streamSimple`);
  }
  return (model, context, options) => mod.streamSimple(model, context, options);
}

/**
 * Registry of live sessions. Each entry owns one Pi Agent plus the set of SSE
 * listeners currently attached to it.
 */
export function createSessionRegistry({ store, config, log = console }) {
  /** @type {Map<string, {agentId: string, agent: Agent, listeners: Set<Function>, model: string}>} */
  const sessions = new Map();

  function broadcast(sessionId, translated) {
    // Persist first so a client attaching mid-run can replay the full history,
    // then fan out to attached listeners.
    try {
      store.insertSessionEvent(sessionId, translated);
    } catch (err) {
      log.error(`[pi] failed to persist event for ${sessionId}:`, err?.message ?? err);
    }
    const entry = sessions.get(sessionId);
    if (!entry) return;
    for (const listener of entry.listeners) {
      try {
        listener(translated);
      } catch (err) {
        log.error("[pi] listener error:", err?.message ?? err);
      }
    }
  }

  /**
   * Create a session bound to a stored agent row.
   * @returns {Promise<{id: string, model: string}>}
   */
  async function createSession(sessionId, agentRow, translate) {
    const permissions = agentRow.permissions || {};
    const toolIds = toolIdsFrom(permissions.tools ?? permissions.allowed_tools);
    const modelName = agentRow.model || config.defaultModel;
    if (!modelName) {
      throw new Error("agent has no model and DEFAULT_MODEL is unset");
    }

    const model = buildModel(modelName, {
      baseUrl: config.baseUrl,
      api: config.api,
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
    });

    const agent = new Agent({
      streamFn: config.streamFn,
      // LAP fronts the gateway, so one key covers every provider id.
      getApiKey: () => config.apiKey,
      sessionId,
      initialState: {
        model,
        systemPrompt: agentRow.system || "You are a helpful agent.",
        tools: selectTools(config.workdir, toolIds),
      },
    });

    // Per-run streaming watermark (see translatePiEvent).
    const ctx = { sessionId, model: modelName, emitted: { text: "", thinking: "" } };
    agent.subscribe((ev) => {
      const translated = translate(ev, ctx);
      if (translated) broadcast(sessionId, translated);
    });

    sessions.set(sessionId, {
      agentId: agentRow.id,
      agent,
      listeners: new Set(),
      model: modelName,
    });
    store.bindSession(sessionId, agentRow.id);
    return { id: sessionId, model: modelName };
  }

  /** Start a prompt without awaiting completion (the caller returns 202). */
  function prompt(sessionId, text, onError) {
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error(`unknown session: ${sessionId}`);
    // Deliberately not awaited: the Managed Agents contract is fire-and-forget,
    // with progress delivered over the SSE stream.
    entry.agent.prompt(text).catch((err) => {
      const message = err?.message ?? String(err);
      log.error(`[pi] run failed for ${sessionId}:`, message);
      onError?.(message);
    });
  }

  function attach(sessionId, listener) {
    const entry = sessions.get(sessionId);
    if (!entry) return () => {};
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  function abort(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    entry.agent.abort();
    return true;
  }

  function get(sessionId) {
    return sessions.get(sessionId);
  }

  function remove(sessionId) {
    const entry = sessions.get(sessionId);
    if (entry) {
      try {
        entry.agent.abort();
      } catch {
        // already idle
      }
      sessions.delete(sessionId);
    }
    store.unbindSession(sessionId);
  }

  return { createSession, prompt, attach, abort, get, remove, broadcast, size: () => sessions.size };
}
