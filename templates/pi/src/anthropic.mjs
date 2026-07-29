// Pure-logic translation layer between the Anthropic Managed Agents API spec
// and Pi Agent Core. No external deps, no I/O — just data mapping. ESM (Node 20).
//
// Pi emits a small, well-typed event union (see AgentEvent in
// @earendil-works/pi-agent-core), which makes this mapping much tighter than
// the opencode equivalent: there is no need to guess at event shapes.

/**
 * Resolve a model identifier from a string or {id, speed?} shape.
 * @param {string|{id?: string}} model
 * @returns {string}
 */
export function modelId(model) {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") return model.id || "";
  return "";
}

/** Map a store agent row to Anthropic-shaped agent JSON. */
export function agentResponse(row) {
  const permissions = row.permissions || {};
  return {
    id: row.id,
    type: "agent",
    name: row.name,
    description: permissions.description ?? null,
    model: { id: row.model || "" },
    system: row.system || "",
    tools: permissions.tools || [],
    mcp_servers: row.mcp_servers || [],
    metadata: permissions.metadata ?? null,
    version: 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Build an Anthropic session JSON object. */
export function sessionResponse({ id, agentId, environmentId }) {
  return {
    id,
    type: "session",
    agent: agentId,
    environment_id: environmentId ?? null,
    status: "running",
  };
}

/**
 * Collect text from Anthropic user.message events into plain text parts.
 * @param {Array<{type: string, content?: any}>} events
 * @returns {Array<{type: "text", text: string}>}
 */
export function partsFromEvents(events) {
  const parts = [];
  if (!Array.isArray(events)) return parts;
  for (const ev of events) {
    if (!ev || ev.type !== "user.message") continue;
    const content = ev.content;
    if (typeof content === "string") {
      if (content) parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") {
          if (item) parts.push({ type: "text", text: item });
        } else if (item && item.type === "text" && item.text) {
          parts.push({ type: "text", text: item.text });
        }
      }
    }
  }
  return parts;
}

/** Extract concatenated text from a Pi AgentMessage's content blocks. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Extract thinking/reasoning text from a Pi AgentMessage's content blocks. */
function messageThinking(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block && (block.type === "thinking" || block.type === "reasoning") &&
        typeof (block.thinking ?? block.text) === "string",
    )
    .map((block) => block.thinking ?? block.text)
    .join("");
}

function toolResultContent(output, error) {
  const value = error ?? output ?? "";
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [{ type: "json", json: value }];
}

/**
 * Translate one Pi AgentEvent into an Anthropic {event, data} pair.
 *
 * Returns null when the event carries no client-visible information.
 *
 * Streaming note: Pi's `message_update` carries the FULL partial message, not a
 * delta. The Anthropic spec expects `agent.message` to carry incremental text,
 * so we diff against the text already emitted for this run (tracked in
 * `ctx.emitted`) and send only the new suffix. Without this the client would
 * render the reply N times with growing prefixes.
 *
 * @param {object} ev Pi AgentEvent
 * @param {{sessionId?: string, model?: string, emitted?: {text: string, thinking: string}}} ctx
 * @returns {{event: string, data: object}|null}
 */
export function translatePiEvent(ev, ctx) {
  if (!ev || typeof ev !== "object") return null;
  const model = ctx.model || null;
  const emitted = ctx.emitted || (ctx.emitted = { text: "", thinking: "" });

  switch (ev.type) {
    case "agent_start":
      emitted.text = "";
      emitted.thinking = "";
      return { event: "session.status_running", data: {} };

    case "message_start":
      // A new assistant message begins — reset the streamed-text watermark so
      // multi-message turns (e.g. after a tool round-trip) stream cleanly.
      emitted.text = "";
      emitted.thinking = "";
      return null;

    case "message_update": {
      const message = ev.message;
      // Only assistant output is streamed; the echoed user message also arrives
      // as a message event and must not be sent back to the client.
      if (message?.role && message.role !== "assistant") return null;

      const thinking = messageThinking(message);
      if (thinking && thinking.length > emitted.thinking.length) {
        const delta = thinking.slice(emitted.thinking.length);
        emitted.thinking = thinking;
        return {
          event: "agent.thinking",
          data: {
            thinking: delta,
            content: [{ type: "thinking", text: delta }],
            model,
          },
        };
      }

      const text = messageText(message);
      if (!text || text.length <= emitted.text.length) return null;
      const delta = text.slice(emitted.text.length);
      emitted.text = text;
      return {
        event: "agent.message",
        data: { content: [{ type: "text", text: delta }], model },
      };
    }

    case "message_end": {
      const message = ev.message;
      if (message?.role && message.role !== "assistant") return null;
      // Emit any tail the updates missed (non-streaming providers may deliver
      // the whole message in one shot with no prior message_update).
      const text = messageText(message);
      if (!text || text.length <= emitted.text.length) return null;
      const delta = text.slice(emitted.text.length);
      emitted.text = text;
      return {
        event: "agent.message",
        data: { content: [{ type: "text", text: delta }], model },
      };
    }

    case "tool_execution_start":
      return {
        event: "agent.tool_use",
        data: {
          id: ev.toolCallId,
          name: ev.toolName,
          tool: ev.toolName,
          status: "running",
          input: ev.args,
        },
      };

    case "tool_execution_end": {
      const error = ev.error ?? ev.result?.isError ?? undefined;
      const output = ev.result?.content ?? ev.result ?? undefined;
      return {
        event: "agent.tool_result",
        data: {
          tool_use_id: ev.toolCallId,
          name: ev.toolName,
          tool: ev.toolName,
          content: toolResultContent(output, ev.error),
          ...(output !== undefined ? { output } : {}),
          ...(error !== undefined && error !== false ? { error } : {}),
        },
      };
    }

    case "agent_end":
      return {
        event: "session.status_idle",
        data: { stop_reason: { type: "end_turn" } },
      };

    // turn_start/turn_end/tool_execution_update carry no extra client state:
    // text already streamed via message_update, tool state via start/end.
    case "turn_start":
    case "turn_end":
    case "tool_execution_update":
      return null;

    default:
      // Log unmapped types so shape changes across Pi versions are diagnosable
      // from container logs, matching the opencode template's behaviour.
      if (typeof ev.type === "string") {
        console.log("[pi] unmapped agent event:", ev.type);
      }
      return null;
  }
}

/** Build a session.error event for a failed run. */
export function errorEvent(message) {
  return { event: "session.error", data: { error: { message: String(message) } } };
}
