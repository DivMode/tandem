/**
 * Shared MCP server builder for tandem.
 *
 * Defines the one seven-tool surface used by both transports:
 *   - src/public-server.ts: OAuth-protected Streamable HTTP (production)
 *   - src/http-mcp.ts: explicit legacy bearer-header migration only
 *   - src/stdio-server.ts: stdio for local desktop apps (no tunnel, no token)
 *
 * Each local tool call reaches the router (../bridge/router.ts) in-process. The same
 * proven handlers regardless of transport. The cwd allowlist, relay isolation,
 * and audit log all live in the router and apply identically to both paths.
 *
 * IMPORT-ORDER CAVEAT: importing this module pulls in the router, which builds
 * the cwd ALLOWLIST from env at module load. Entrypoints must bridge the
 * TANDEM_* env vars to the engine's CCM_* names BEFORE importing this module
 * (both entrypoints use a dynamic `await import(...)` after env setup).
 *
 * The tool surface contains eight tools. read_session is folded into
 * send_to_session (empty text = poll mode); the four relay tools are folded into
 * one `relay` tool with an `action`. The underlying routes are unchanged, so the
 * full capability set remains reachable.
 *
 * ORCHESTRATION POLICY: the server also advertises how it expects to be driven,
 * from ONE canonical source (./orchestration-policy.ts) reaching clients three
 * ways — the MCP `initialize` result's `instructions` (a client-consumption
 * HINT: a client MAY use it or ignore it), concise per-tool snippets in the
 * descriptions below, and the full versioned document from the read-only
 * `get_orchestration_policy` tool. The rules that must actually hold — the
 * Opus default and the explicit-user-only Fable gate — are enforced in the
 * router (bridge/model-policy.ts) and fail closed whether or not a client ever
 * read any of that text.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { routeForTest } from "../bridge/router.ts";
import {
  dispatchListDevices,
  dispatchListSessions,
  dispatchOpenSession,
  dispatchSessionOp,
} from "../bridge/fleet-dispatch.ts";
import { createFleetRuntime, type FleetRuntime } from "../bridge/fleet-runtime.ts";
import { ICON_MIME, ICON_DATA_URI } from "./icon.ts";
import {
  ORCHESTRATION_INSTRUCTIONS,
  ORCHESTRATION_POLICY,
  ORCHESTRATION_POLICY_VERSION,
  TOOL_GUIDANCE,
} from "./orchestration-policy.ts";
import { FABLE_CONSENT_FIELD } from "../bridge/model-policy.ts";

/** Standing warning prepended to the tool descriptions that DRIVE a real
 *  session (open/send/interrupt/close/relay): real machine, real actions.
 *
 *  It is deliberately absent from the two read-only tools. `list_devices`
 *  reports fleet membership and `get_orchestration_policy` returns static
 *  text — neither opens, changes, or touches a session, and prefixing them
 *  with a blast-radius warning would misdescribe them and dull the warning
 *  where it actually matters. Their read-only nature is stated in their own
 *  descriptions, and get_orchestration_policy carries machine-readable
 *  readOnly/non-destructive annotations. */
const BLAST_RADIUS =
  "WARNING: this controls a REAL interactive engine session on the host machine. Claude " +
  "Code in tmux is the default. codex/shell/hermes are " +
  "DISABLED unless the host explicitly enables them (TANDEM_ENABLED_ENGINES); shell, " +
  "if enabled, is arbitrary OS-user command execution starting in the allowlisted cwd, " +
  "not a sandbox. May read, edit, or delete files and run shell commands in the chosen " +
  "working directory. Treat every call as a real action.";

/** Compile-time pin: the literal `user_requested_fable` keys in the tool
 *  schemas below MUST stay identical to the constant the router reads out of
 *  the request body. If either side is renamed, this stops compiling instead
 *  of silently turning the Fable gate into an always-denied field. */
const FABLE_CONSENT_FIELD_NAME: "user_requested_fable" = FABLE_CONSENT_FIELD;

const q = (params: Record<string, string | number | undefined>) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : "";
};

/** Run a route call and wrap the bridge result as an MCP text content block. */
async function call(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  rawQuery = "",
) {
  const result = await routeForTest(method, path, body, rawQuery);
  return { content: [{ type: "text" as const, text: JSON.stringify(result.body) }] };
}

/** Wraps an already-computed { status, body } (local OR fleet-routed) the
 *  same way `call()` wraps a direct router result. Status is intentionally
 *  dropped from the text body, matching call()'s existing shape exactly. */
function wrap(result: { status: number; body: unknown }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result.body) }] };
}

/**
 * Builds the MCP server. `fleet`, when supplied, is the SAME FleetRuntime the
 * production HTTP entrypoint shares with its private fleet listener.
 * Every tool call below routes through bridge/fleet-dispatch.ts, which
 * falls back to the exact pre-Phase-3 local behavior whenever no `device` is
 * given and the call resolves to local (see fleet-dispatch.ts for the full
 * resolution rules). The stdio transport uses a local-only runtime, so callers
 * get the same device-aware schema without opening a network listener.
 */
export function buildMcpServer(fleet?: FleetRuntime): McpServer {
  const runtime = fleet ?? createFleetRuntime({ localEngines: ["claude"] });
  // `icons` rides in the server's implementation info (a self-contained data:
  // URI, so no public URL is needed). A spec-aware client renders the Tandem
  // agent mark next to the connector and its tools. The HTTP transport's
  // /favicon.ico + /icon.png routes cover clients that instead fetch the
  // origin's favicon.
  const server = new McpServer(
    {
      name: "tandem",
      version: "0.1.0",
      icons: [{ src: ICON_DATA_URI, mimeType: ICON_MIME, sizes: ["640x640"] }],
    },
    // Server-level guidance returned in the `initialize` result. This is the
    // SDK's supported ServerOptions field, not a custom protocol extension.
    { instructions: ORCHESTRATION_INSTRUCTIONS },
  );

  /* ---- sessions ---- */

  const deviceParamDescription =
    "Fleet device id to route to, or \"local\" for this hub. Omit to use the configured default device or the sole online device (local counts as one) uniquely capable of the requested engine; an unresolvable ambiguity fails with a 409 listing candidates. A composite \"device:localName\" session name implies its device and must not conflict with an explicit device here (400 if it does).";

  server.tool(
    "open_session",
    `${BLAST_RADIUS}\n\nOpen or attach to a visible interactive session. Supported engine ids are claude, codex, shell, and hermes. Claude is enabled by default; every other engine needs host opt-in and must be available. Claude and Codex use the host's configured native terminal backend (tmux or Herdr) and require an admitted start cwd. Shell is tmux-only. Hermes attaches only to an explicitly allowlisted writable agent id through a loopback gateway and does not accept cwd.\n\nClaude permission bypass is off by default. model and effort are also Claude-only. Unknown, disabled, unavailable, or incompatible options fail before spawn or gateway contact. A remote open returns a stable global name in the form "<deviceId>:<localName>". Preserve that exact name for later calls so routing cannot drift.

${TOOL_GUIDANCE.openSession}`,
    {
      name: z.string().optional().describe("Short name (A-Z a-z 0-9 . _ -); auto-generated if omitted. For engine=hermes this is the writable agent id (required, must be allowlisted)."),
      cwd: z.string().optional().describe("Working dir; must be on the allowlist (default the configured cwd). Not supported for engine=hermes."),
      model: z.string().optional().describe("Claude-only session model: alias (default|opus|sonnet|haiku|fable) or a full claude-* id. OMIT for the opus default (Opus 5); \"default\" resolves to that same opus default, not to the host's CLI configuration. fable/claude-fable-* additionally requires user_requested_fable. Rejected (400) for any other engine."),
      effort: z.string().optional().describe("Claude-only thinking effort: low|medium|high|xhigh|max. Rejected (400) for any other engine."),
      engine: z.enum(["claude", "codex", "shell", "hermes"]).optional().describe("Engine to drive this session. Defaults to claude. codex/shell/hermes require TANDEM_ENABLED_ENGINES opt-in."),
      device: z.string().optional().describe(deviceParamDescription),
      // Literal key (not a computed one) so zod keeps the named-field inference
      // the SDK's tool callback typing depends on. FABLE_CONSENT_FIELD_NAME
      // below pins the literal to the canonical constant at compile time.
      user_requested_fable: z.boolean().optional().describe(TOOL_GUIDANCE.fableParam),
    },
    async ({ name, cwd, model, effort, engine, device, user_requested_fable }) => {
      return wrap(
        await dispatchOpenSession(runtime, { name, cwd, model, effort, engine, device, user_requested_fable }),
      );
    },
  );

  server.tool(
    "list_sessions",
    `${BLAST_RADIUS}\n\nRead-only. List live sessions Tandem owns and can drive on the local hub or one selected device. Tandem does not scan arbitrary tmux sessions or return history. Remote ids are rewritten as stable "<deviceId>:<localName>" names and include device and localName fields.

${TOOL_GUIDANCE.listSessions}`,
    {
      limit: z.number().int().positive().optional(),
      project: z.string().optional(),
      device: z.string().optional().describe("Fleet device id to list, or omit for local."),
    },
    async ({ limit, project, device }) => {
      return wrap(await dispatchListSessions(runtime, device, { limit, project }));
    },
  );

  server.tool(
    "send_to_session",
    `${BLAST_RADIUS}\n\nSend one instruction to a live session and wait up to TANDEM_WAIT_MS. A bounded timeout returns status "running" and a cursor; poll again with empty text and that cursor instead of resending the instruction. Empty text reads only newer output and returns idle when the turn is done. Completion events are also written as described in README.\n\nSlash commands and shell lines are passed through verbatim and execute in the target session. Optional model and effort controls are Claude-only and are rejected for every other engine.

${TOOL_GUIDANCE.sendToSession}`,
    {
      name: z.string().describe("A bare local name (always local), or a fleet-routed \"<deviceId>:<localName>\" name returned by open_session/list_sessions."),
      text: z.string().optional().describe("Instruction OR a slash command (verbatim). Omit/empty = poll mode (read new output only)."),
      cursor: z.number().int().nonnegative().optional().describe("Poll mode: byte cursor from a previous result; returns only newer output."),
      model: z.string().optional().describe("Claude-only: override model for this turn (default|opus|sonnet|haiku|fable or a full claude-* id). Omitted keeps the session's own model; an explicit \"default\" switches this turn to the opus default. fable/claude-fable-* additionally requires user_requested_fable. Rejected (400) for any other engine."),
      effort: z.string().optional().describe("Claude-only: override thinking effort for this turn (low|medium|high|xhigh|max). Rejected (400) for any other engine."),
      device: z.string().optional().describe(deviceParamDescription),
      user_requested_fable: z.boolean().optional().describe(TOOL_GUIDANCE.fableParam),
    },
    async ({ name, text, cursor, model, effort, device, user_requested_fable }) => {
      return wrap(
        await dispatchSessionOp(runtime, "send", name, device, {
          text: text ?? "",
          cursor,
          model,
          effort,
          user_requested_fable,
        }),
      );
    },
  );

  server.tool(
    "interrupt_session",
    `${BLAST_RADIUS}\n\nStop a runaway turn (sends Escape / Ctrl-C to the TUI). The session stays open. Returns { ok, name }.`,
    {
      name: z.string().describe("A bare local name (always local), or a fleet-routed \"<deviceId>:<localName>\" name returned by open_session/list_sessions."),
      device: z.string().optional().describe(deviceParamDescription),
    },
    async ({ name, device }) => {
      return wrap(await dispatchSessionOp(runtime, "interrupt", name, device, {}));
    },
  );

  server.tool(
    "close_session",
    `${BLAST_RADIUS}\n\nEnd the interactive TUI. With Herdr this closes only the Tandem-owned, provenance-checked workspace; with tmux it kills the owned tmux session. Idempotent. Returns { ok, name }.`,
    {
      name: z.string().describe("A bare local name (always local), or a fleet-routed \"<deviceId>:<localName>\" name returned by open_session/list_sessions."),
      device: z.string().optional().describe(deviceParamDescription),
    },
    async ({ name, device }) => {
      return wrap(await dispatchSessionOp(runtime, "close", name, device, {}));
    },
  );

  server.tool(
    "list_devices",
    "List this hub and every connected fleet device. Returns { devices: [{ id, name, online, engines }] } with exactly those four fields. IP addresses, hostnames, usernames, tailnet identities, filesystem paths, tokens, and nonces are never included.",
    {},
    async () => {
      return wrap(dispatchListDevices(runtime));
    },
  );

  /* ---- orchestration policy (read-only) ---- */

  // registerTool (not the deprecated `tool` overloads) so the read-only
  // annotations ride along: a client that filters or auto-approves by
  // annotation can see this tool touches nothing.
  server.registerTool(
    "get_orchestration_policy",
    {
      title: "Get orchestration policy",
      description: TOOL_GUIDANCE.policyTool,
      inputSchema: {},
      annotations: {
        title: "Get orchestration policy",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            version: ORCHESTRATION_POLICY_VERSION,
            policy: ORCHESTRATION_POLICY,
            instructions: ORCHESTRATION_INSTRUCTIONS,
            note:
              "The same policy is offered as the MCP initialize result's `instructions`, which is a client-consumption hint (a client MAY use it). The session, polling, and model-routing rules are enforced by this server regardless of whether any client read them.",
          }),
        },
      ],
    }),
  );

  /* ---- relay (one tool, five actions) ---- */

  server.tool(
    "relay",
    `${BLAST_RADIUS}\n\nControl the optional persistent Claude-only lead and worker loop. This is not the general multi-engine fleet mechanism and cannot route to a device. It is unavailable with the Herdr terminal backend. start requires TANDEM_ALLOW_BYPASS=1 and fails before opening sessions when bypass is off. The lead parks after a task and can accept more work until stopped or bounded cleanup ends the loop.\n\nActions: start begins a goal; read fetches transcript output; enqueue supplies the next task or answers NEEDS_INPUT; inject steers an actively running task; stop ends the loop. Completion and escalation events follow the README notification policy.`,
    {
      action: z.enum(["start", "read", "inject", "stop", "enqueue"]),
      goal: z.string().optional().describe('action=start: the relay objective.'),
      cwd: z.string().optional().describe('action=start: working dir (allowlisted).'),
      maxTurns: z.number().int().positive().optional().describe('action=start: per-task hard cap on turns.'),
      loopId: z.string().optional().describe('action=read|inject|stop|enqueue: the loop id from start.'),
      cursor: z.number().int().nonnegative().optional().describe('action=read: byte cursor to page from.'),
      message: z.string().optional().describe('action=inject: steer a RUNNING task (rejected while parked).'),
      task: z.string().optional().describe('action=enqueue: the next task, OR the answer to a NEEDS_INPUT question.'),
    },
    async ({ action, goal, cwd, maxTurns, loopId, cursor, message, task }) => {
      const id = encodeURIComponent(loopId ?? "");
      switch (action) {
        case "start":
          return call("POST", "/relay/start", { goal, cwd, maxTurns });
        case "read":
          return call("GET", `/relay/${id}/read`, {}, q({ cursor }).slice(1));
        case "enqueue":
          return call("POST", `/relay/${id}/enqueue`, { task });
        case "inject":
          return call("POST", `/relay/${id}/inject`, { message });
        case "stop":
          return call("POST", `/relay/${id}/stop`);
      }
    },
  );

  return server;
}
