/**
 * HTTP MCP server for tandem.
 *
 * Exposes the bridge as a Streamable-HTTP MCP server on localhost; your own
 * cloudflared quick tunnel publishes it to https://<random>.trycloudflare.com
 * for a chat AI (Claude.ai) to connect to. Each tool calls the local router
 * (../bridge/router.ts) in-process — the same proven handlers the original used,
 * minus the Worker tunnel.
 *
 * AUTH: every request must present TANDEM_TOKEN. Accepted as:
 *   - Authorization: Bearer <token>   (preferred)
 *   - ?token=<token>                  (query string)
 *   - /<token>/mcp                    (path prefix, handy for connector configs)
 * Any request without a matching token gets 401 and never reaches a tool.
 *
 * Tool surface is consolidated (phase 3): 6 tools. read_session is folded into
 * send_to_session (empty text = poll mode); the four relay tools are folded into
 * one `relay` tool with an `action`. The underlying routes are unchanged, so the
 * full capability set remains reachable.
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { routeForTest, getAllowlist } from "../bridge/router.ts";

export interface ServerOpts {
  token: string;
  port: number;
  host: string;
}

/** Standing warning prepended to every tool description (real machine, real actions). */
const BLAST_RADIUS =
  "WARNING: this runs REAL Claude Code on the host machine (an interactive claude " +
  "TUI in tmux, on the user's subscription) and may read, edit, or delete files and " +
  "run shell commands in the chosen working directory. Treat every call as a real action.";

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

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "tandem", version: "0.1.0" });

  /* ---- sessions ---- */

  server.tool(
    "open_session",
    `${BLAST_RADIUS}\n\nSpawn a fresh, visible, INTERACTIVE Claude Code session in tmux ("ccm-<name>") in the given working directory; returns { name, cwd, attachHint }. Idempotent. cwd must be on the bridge allowlist. Launches in skip-permissions (autonomous) mode by default so turns don't stall on allow-prompts (set TANDEM_SKIP_PERMISSIONS=0 to disable); the cwd allowlist is enforced BEFORE spawn regardless, so this never widens reachable directories. Optional model/effort are session-scoped (claude --model / --effort).`,
    {
      name: z.string().optional().describe("Short name (A-Z a-z 0-9 . _ -); auto-generated if omitted."),
      cwd: z.string().optional().describe("Working dir; must be on the allowlist (default the configured cwd)."),
      model: z.string().optional().describe("Session model: alias (default|opus|sonnet|haiku) or a full claude-* id. Session-scoped; unsupported values are rejected (400)."),
      effort: z.string().optional().describe("Thinking effort: low|medium|high|xhigh|max. Session-scoped; unsupported values are rejected (400)."),
    },
    async ({ name, cwd, model, effort }) => call("POST", "/sessions/open", { name, cwd, model, effort }),
  );

  server.tool(
    "list_sessions",
    `${BLAST_RADIUS}\n\nList Claude Code sessions: LIVE tmux sessions the bridge is driving (with a "tmux attach -t ccm-<name>" hint) first, then recent local history. Read-only.`,
    { limit: z.number().int().positive().optional(), project: z.string().optional() },
    async ({ limit, project }) => call("GET", "/sessions", {}, q({ limit, project }).slice(1)),
  );

  server.tool(
    "send_to_session",
    `${BLAST_RADIUS}\n\nSend a prompt to a live session and wait (BOUNDED by TANDEM_WAIT_MS) for the turn to finish, returning { status, report, cursor }. If the turn is still running at the cap it returns { status:"running", cursor } — call again to keep waiting (never an infinite internal loop). POLL MODE: omit/empty 'text' to just fetch new output since 'cursor' without sending a new instruction → { text, cursor, idle } (idle:true means the turn is done). When a turn finishes the bridge ALSO emits a completion event (see README "Completion events"), so polling is optional.\n\nSLASH COMMANDS: any slash command sent as 'text' reaches the TUI verbatim and executes — e.g. "/status", "/mcp", "/model opus", "/goal ...", and custom commands. PER-TURN OVERRIDE: optional model/effort set the model/thinking effort for this turn via in-session controls applied before the prompt (these also persist as the saved default for new sessions; for strictly session-scoped control set them at open_session instead).`,
    {
      name: z.string(),
      text: z.string().optional().describe("Instruction OR a slash command (verbatim). Omit/empty = poll mode (read new output only)."),
      cursor: z.number().int().nonnegative().optional().describe("Poll mode: byte cursor from a previous result; returns only newer output."),
      model: z.string().optional().describe("Override model for this turn: default|opus|sonnet|haiku or a full claude-* id. Unsupported values rejected (400)."),
      effort: z.string().optional().describe("Override thinking effort for this turn: low|medium|high|xhigh|max. Unsupported values rejected (400)."),
    },
    async ({ name, text, cursor, model, effort }) =>
      call("POST", `/sessions/${encodeURIComponent(name)}/send`, { text: text ?? "", cursor, model, effort }),
  );

  server.tool(
    "interrupt_session",
    `${BLAST_RADIUS}\n\nStop a runaway turn (sends Escape / Ctrl-C to the TUI). The session stays open. Returns { ok, name }.`,
    { name: z.string() },
    async ({ name }) => call("POST", `/sessions/${encodeURIComponent(name)}/interrupt`),
  );

  server.tool(
    "close_session",
    `${BLAST_RADIUS}\n\nKill the live tmux session (ends the interactive TUI). Idempotent. Returns { ok, name }.`,
    { name: z.string() },
    async ({ name }) => call("POST", `/sessions/${encodeURIComponent(name)}/close`),
  );

  /* ---- relay (one tool, five actions) ---- */

  server.tool(
    "relay",
    `${BLAST_RADIUS}\n\nControl the autonomous, NO-HUMAN-IN-THE-LOOP lead/worker relay (two interactive Claude Code sessions that message each other). The lead is a PERSISTENT manager: when a task finishes it PARKS (stays alive, idle) and waits for the next task instead of dying; it tears down on stop, an idle-timeout, when it asks an unanswered question too long, or when it escalates terminal "BLOCKED". action:\n- "start": begin a relay — needs { goal, cwd?, maxTurns? } → { status:"running", loopId, leadName, workerName }\n- "read": fetch the lead<->worker transcript — needs { loopId, cursor? } → { text, cursor, running } (running:false = finished)\n- "enqueue": give the parked/running manager the NEXT task — needs { loopId, task } → { ok, queued }. ALSO the channel to ANSWER a question: if the manager asked NEEDS_INPUT and is awaiting an answer, the first enqueue is treated as that answer and RESUMES the same task.\n- "inject": steer the lead mid-task (only while a task is actively RUNNING; rejected while parked/awaiting-answer — use enqueue to answer) — needs { loopId, message }\n- "stop": halt promptly — needs { loopId }\nNotifications: routine task completions are SILENT (logged, no phone push); the manager buzzes the phone only when it NEEDS YOUR ANSWER (urgent, stays alive) or is FULLY FINISHED; a terminal BLOCKED emits an urgent escalation (see README "Completion events").`,
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

/** Length-independent token compare. */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function extractToken(req: http.IncomingMessage, url: URL): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  const m = url.pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (m && m[2]) return m[1];
  return "";
}

export async function startServer(opts: ServerOpts): Promise<void> {
  const allowlist = getAllowlist();
  if (allowlist.length === 0) {
    console.error(
      "⚠  cwd allowlist is empty — open_session/relay will refuse every directory.\n" +
        "   Set TANDEM_CWD_ALLOWLIST to the folders the bridge may work in.",
    );
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${opts.host}:${opts.port}`);

    // Health check needs no auth and exposes nothing sensitive.
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "tandem" }));
      return;
    }

    if (!tokenMatches(extractToken(req, url), opts.token)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized: missing or invalid token" }));
      return;
    }

    // Authenticated. Handle statelessly; session/relay state lives in the engine
    // modules, so it persists across requests regardless.
    const body = await readBody(req);
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  console.error(`tandem MCP bridge listening on http://${opts.host}:${opts.port}  (token required)`);
  console.error(`cwd allowlist: ${allowlist.join(":") || "(empty — set TANDEM_CWD_ALLOWLIST)"}`);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}
