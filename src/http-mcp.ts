/**
 * HTTP MCP server for tandem.
 *
 * Exposes the bridge as a Streamable-HTTP MCP server on localhost. A transport
 * chosen by the operator can publish it to an MCP-capable client. This is a
 * migration-only boundary. OAuth is the production default.
 *
 * AUTH: every `/mcp` request must present TANDEM_TOKEN in an Authorization
 * bearer header. Query and path tokens are deliberately unsupported.
 *
 * The tool surface is defined once in ./mcp-server.ts and shared with
 * the local stdio transport (src/stdio-server.ts).
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getAllowlist } from "../bridge/router.ts";
import type { FleetRuntime } from "../bridge/fleet-runtime.ts";
import { buildMcpServer } from "./mcp-server.ts";
import { ICON_PNG, ICON_MIME } from "./icon.ts";

export interface ServerOpts {
  token: string;
  port: number;
  host: string;
  /** When the production entrypoint has configured TANDEM_FLEET_TOKEN,
   *  this is the same FleetRuntime shared with the private fleet listener.
   *  every per-request MCP server below is built with it, so fleet routing
   *  (list_devices, device-scoped tool calls) is available on every request.
   *  Undefined ⇒ pure local behavior, unchanged from Phase 2. */
  fleet?: FleetRuntime;
}

export interface ServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

const MAX_REQUEST_BYTES = 1_048_576;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertPublicLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("public MCP listener must bind to an exact loopback host");
  }
}

/** Constant-time token compare for equal-length byte sequences. */
function tokenMatches(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return presentedBytes.length === expectedBytes.length && timingSafeEqual(presentedBytes, expectedBytes);
}

function extractToken(req: http.IncomingMessage): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

export async function startServer(opts: ServerOpts): Promise<ServerHandle> {
  assertPublicLoopbackHost(opts.host);
  if (opts.token.trim().length < 16) {
    throw new Error("public MCP token must contain at least 16 characters");
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65_535) {
    throw new Error("public MCP port must be an integer from 0 to 65535");
  }
  const allowlist = getAllowlist();
  if (allowlist.length === 0) {
    console.error(
      "⚠  cwd allowlist is empty: open_session/relay will refuse every directory.\n" +
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

    // Icon / favicon: served WITHOUT auth (it's a public, non-sensitive asset)
    // so a connector UI that fetches the origin's favicon can
    // show the Tandem agent mark next to the connector. Cached for a day.
    if (url.pathname === "/favicon.ico" || url.pathname === "/icon.png") {
      res.writeHead(200, {
        "content-type": ICON_MIME,
        "content-length": String(ICON_PNG.length),
        "cache-control": "public, max-age=86400",
      });
      res.end(ICON_PNG);
      return;
    }

    if (url.pathname !== "/mcp" || url.search || url.hash) {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (!tokenMatches(extractToken(req), opts.token)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": 'Bearer realm="tandem"',
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Authenticated. Handle statelessly; session/relay state lives in the engine
    // modules, so it persists across requests regardless.
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: status === 413 ? "request body too large" : "invalid request body" }));
      return;
    }
    const server = buildMcpServer(opts.fleet);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void transport.close();
      void server.close();
    };
    res.once("close", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      console.error("tandem MCP request failed");
      cleanup();
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "internal MCP request failure" }));
      } else {
        res.destroy();
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;
  console.error(`tandem legacy MCP bridge listening on loopback port ${port} (bearer header required)`);
  console.error(`cwd allowlist roots: ${allowlist.length}`);

  return {
    port,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

class RequestBodyTooLargeError extends Error {}
class InvalidRequestBodyError extends Error {}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) {
        settled = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new InvalidRequestBodyError());
      }
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new InvalidRequestBodyError());
    });
  });
}
