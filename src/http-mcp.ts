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

  /* ---- drive a local interactive Claude Code session ---- */

  server.tool(
    "list_sessions",
    `${BLAST_RADIUS}\n\nList Claude Code sessions: LIVE tmux sessions the bridge is driving (with a "tmux attach -t ccm-<name>" hint) first, then recent local history. Read-only.`,
    { limit: z.number().int().positive().optional(), project: z.string().optional() },
    async ({ limit, project }) => call("GET", "/sessions", {}, q({ limit, project }).slice(1)),
  );

  server.tool(
    "open_session",
    `${BLAST_RADIUS}\n\nSpawn a fresh, visible, INTERACTIVE Claude Code session in tmux ("ccm-<name>") in the given working directory; returns { name, cwd, attachHint }. Idempotent. cwd must be on the bridge allowlist.`,
    {
      name: z.string().optional().describe("Short name (A-Z a-z 0-9 . _ -); auto-generated if omitted."),
      cwd: z.string().optional().describe("Working dir; must be on the allowlist (default the configured cwd)."),
    },
    async ({ name, cwd }) => call("POST", "/sessions/open", { name, cwd }),
  );

  server.tool(
    "send_to_session",
    `${BLAST_RADIUS}\n\nType a prompt into a live session and wait (held open) for the turn to finish, returning { status, report, cursor }. If it runs past the window the bridge returns { status: "running", cursor } — then poll read_session with that cursor until idle:true.`,
    {
      name: z.string(),
      text: z.string(),
      waitForTurn: z.boolean().optional(),
    },
    async ({ name, text, waitForTurn }) =>
      call("POST", `/sessions/${encodeURIComponent(name)}/send`, { text, waitForTurn }),
  );

  server.tool(
    "read_session",
    `${BLAST_RADIUS}\n\nRead a live session's transcript WITHOUT sending anything (the poll primitive). Returns { text, cursor, idle }: idle:true means the turn is DONE. Pass the returned cursor back as sinceCursor to page incrementally.`,
    { name: z.string(), sinceCursor: z.number().int().nonnegative().optional() },
    async ({ name, sinceCursor }) =>
      call("GET", `/sessions/${encodeURIComponent(name)}/read`, {}, q({ cursor: sinceCursor }).slice(1)),
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

  /* ---- zero-API two-session autonomous relay ---- */

  server.tool(
    "start_relay",
    `${BLAST_RADIUS}\n\nKick off a NO-HUMAN-IN-THE-LOOP relay: TWO interactive Claude Code sessions (a "lead" strategist/reviewer and a "worker" that does the hands-on work) message each other until the lead says RELAY_DONE, a max-turn cap is hit, or it is stopped. Returns { status:"running", loopId, leadName, workerName, cursor }. Watch with read_relay; steer with inject_to_relay; halt with stop_relay.`,
    {
      goal: z.string(),
      cwd: z.string().optional(),
      maxTurns: z.number().int().positive().optional(),
    },
    async ({ goal, cwd, maxTurns }) => call("POST", "/relay/start", { goal, cwd, maxTurns }),
  );

  server.tool(
    "read_relay",
    `${BLAST_RADIUS}\n\nRead the lead<->worker conversation WITHOUT sending anything. Returns { text, cursor, running }: running:false means finished. Pass the cursor back as sinceCursor to page incrementally.`,
    { loopId: z.string(), sinceCursor: z.number().int().nonnegative().optional() },
    async ({ loopId, sinceCursor }) =>
      call("GET", `/relay/${encodeURIComponent(loopId)}/read`, {}, q({ cursor: sinceCursor }).slice(1)),
  );

  server.tool(
    "inject_to_relay",
    `${BLAST_RADIUS}\n\nBarge in on a running relay: deliver a message to the lead (course-correct, add a constraint, answer a question) that it sees at the top of its next turn. The loop keeps running. Returns { ok }.`,
    { loopId: z.string(), message: z.string() },
    async ({ loopId, message }) =>
      call("POST", `/relay/${encodeURIComponent(loopId)}/inject`, { message }),
  );

  server.tool(
    "stop_relay",
    `${BLAST_RADIUS}\n\nHalt a running relay loop and interrupt the session mid-turn so it stops promptly. Returns { ok, running }.`,
    { loopId: z.string() },
    async ({ loopId }) => call("POST", `/relay/${encodeURIComponent(loopId)}/stop`),
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
      "⚠  cwd allowlist is empty — open_session/start_relay will refuse every directory.\n" +
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
