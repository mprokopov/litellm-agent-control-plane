// Tool implementations for the Pi agent runtime.
//
// Pi tool schemas are TypeBox (`Type` is re-exported by @earendil-works/pi-ai).
// Each tool matches the AgentTool contract:
//   {name, label, description, parameters, execute(toolCallId, params, signal)}
// `execute` must THROW on failure rather than encoding errors in `content`.
//
// Tool ids intentionally mirror the ones LAP offers in its agent builder
// (bash/read/write/edit/glob/grep) so the UI checkboxes map 1:1.

import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";

const BASH_TIMEOUT_MS = Number(process.env.BASH_TIMEOUT_MS || 120_000);
const MAX_OUTPUT_CHARS = Number(process.env.MAX_TOOL_OUTPUT_CHARS || 30_000);

/** Wrap a plain string as the AgentToolResult content array. */
function textResult(text, details = {}) {
  const value = text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`
    : text;
  return { content: [{ type: "text", text: value }], details };
}

/**
 * Resolve a caller-supplied path inside the workspace.
 * Throws on escape attempts so an agent cannot read outside its workspace.
 */
function resolveInWorkspace(workdir, target) {
  const abs = path.resolve(workdir, target ?? ".");
  const root = path.resolve(workdir);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return abs;
}

/** Convert a glob pattern into an anchored regex. `**` spans separators, `*` does not. */
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** List workspace-relative file paths, skipping noisy directories. */
async function walkFiles(workdir) {
  const entries = await readdir(workdir, { recursive: true, withFileTypes: true });
  const skip = /(^|\/)(node_modules|\.git|dist|\.next|target)(\/|$)/;
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Node returns parentPath (>=20.12) or path (older) for recursive readdir.
    const parent = entry.parentPath ?? entry.path ?? workdir;
    const rel = path.relative(workdir, path.join(parent, entry.name));
    if (skip.test(rel)) continue;
    files.push(rel);
  }
  return files;
}

export function buildTools(workdir) {
  // SECURITY: this tool deliberately runs model-authored commands through a
  // shell (`exec`, not `execFile`) because shell features — pipes, redirection,
  // globbing, `&&` — are the point of a bash tool; an argument array would
  // break it. There is no input to sanitize here: the command IS the payload,
  // exactly as in LAP's own `bash` tool. The security boundary is therefore the
  // container, not argument escaping. Run this template in an isolated
  // container with no ambient cloud credentials, and prefer per-agent tool
  // selection (omit "bash") for untrusted prompts.
  const bash = {
    name: "bash",
    label: "Shell",
    description: "Run a shell command in the agent workspace and return combined stdout/stderr.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
    }),
    execute: (_id, { command }, signal) =>
      new Promise((resolve, reject) => {
        exec(
          command,
          { cwd: workdir, timeout: BASH_TIMEOUT_MS, signal, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const combined = `${stdout ?? ""}${stderr ?? ""}`;
            // A non-zero exit is information for the model, not a tool failure.
            if (err && err.killed) {
              reject(new Error(`command timed out after ${BASH_TIMEOUT_MS}ms`));
              return;
            }
            resolve(
              textResult(combined.trim() || "(no output)", {
                exitCode: err?.code ?? 0,
              }),
            );
          },
        );
      }),
  };

  const read = {
    name: "read",
    label: "Read files",
    description: "Read a UTF-8 file from the agent workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
    }),
    async execute(_id, { path: target }) {
      const abs = resolveInWorkspace(workdir, target);
      const text = await readFile(abs, "utf8");
      return textResult(text, { path: target, bytes: Buffer.byteLength(text) });
    },
  };

  const write = {
    name: "write",
    label: "Write files",
    description: "Create or overwrite a file in the agent workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
      content: Type.String({ description: "Full file contents" }),
    }),
    async execute(_id, { path: target, content }) {
      const abs = resolveInWorkspace(workdir, target);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return textResult(`wrote ${target} (${Buffer.byteLength(content)} bytes)`, { path: target });
    },
  };

  const edit = {
    name: "edit",
    label: "Edit files",
    description:
      "Replace an exact string in a workspace file. The old string must appear exactly once.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
      old_string: Type.String({ description: "Exact text to replace" }),
      new_string: Type.String({ description: "Replacement text" }),
    }),
    async execute(_id, { path: target, old_string: oldStr, new_string: newStr }) {
      const abs = resolveInWorkspace(workdir, target);
      const text = await readFile(abs, "utf8");
      const first = text.indexOf(oldStr);
      if (first === -1) throw new Error(`old_string not found in ${target}`);
      if (text.indexOf(oldStr, first + oldStr.length) !== -1) {
        throw new Error(`old_string is not unique in ${target}`);
      }
      await writeFile(abs, text.replace(oldStr, newStr), "utf8");
      return textResult(`edited ${target}`, { path: target });
    },
  };

  const glob = {
    name: "glob",
    label: "Find files",
    description: "Find workspace files matching a glob pattern (e.g. src/**/*.mjs).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern, workspace-relative" }),
    }),
    async execute(_id, { pattern }) {
      const re = globToRegExp(pattern);
      const matches = (await walkFiles(workdir)).filter((rel) => re.test(rel)).sort();
      return textResult(matches.join("\n") || "(no matches)", { count: matches.length });
    },
  };

  const grep = {
    name: "grep",
    label: "Search files",
    description: "Search workspace file contents with a regular expression.",
    parameters: Type.Object({
      pattern: Type.String({ description: "JavaScript regular expression" }),
      path_glob: Type.Optional(
        Type.String({ description: "Optional glob restricting which files are searched" }),
      ),
    }),
    async execute(_id, { pattern, path_glob: pathGlob }) {
      const re = new RegExp(pattern);
      const fileFilter = pathGlob ? globToRegExp(pathGlob) : null;
      const hits = [];
      for (const rel of await walkFiles(workdir)) {
        if (fileFilter && !fileFilter.test(rel)) continue;
        let text;
        try {
          text = await readFile(path.join(workdir, rel), "utf8");
        } catch {
          continue; // unreadable or binary — skip
        }
        text.split("\n").forEach((line, idx) => {
          if (re.test(line)) hits.push(`${rel}:${idx + 1}:${line.trim().slice(0, 300)}`);
        });
        if (hits.length > 500) break;
      }
      return textResult(hits.join("\n") || "(no matches)", { count: hits.length });
    },
  };

  return { bash, read, write, edit, glob, grep };
}

/**
 * Normalize the many shapes LAP may send for tool selection into plain ids.
 * Accepts ["bash"], [{type:"bash"}], [{id:"bash"}], or {bash:true}.
 */
export function toolIdsFrom(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const ids = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return item.type || item.id || item.name || "";
        return "";
      })
      .filter(Boolean);
    return ids.length ? ids : null;
  }
  if (typeof value === "object") {
    const ids = Object.entries(value)
      .filter(([, enabled]) => enabled !== false)
      .map(([id]) => id);
    return ids.length ? ids : null;
  }
  return null;
}

/** Select AgentTools by id, falling back to the full set when nothing is specified. */
export function selectTools(workdir, requestedIds) {
  const all = buildTools(workdir);
  if (!requestedIds || !requestedIds.length) return Object.values(all);
  const picked = requestedIds.map((id) => all[id]).filter(Boolean);
  return picked.length ? picked : Object.values(all);
}
