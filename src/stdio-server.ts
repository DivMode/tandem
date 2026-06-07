/**
 * tandem — local stdio entrypoint (desktop, no tunnel).
 *
 * Runs the SAME MCP server as the HTTP transport (src/mcp-server.ts → the same
 * router, the same 6 tools) over stdio, for desktop chat apps (Claude Desktop,
 * ChatGPT desktop) that spawn the bridge themselves as a child process. Nothing
 * listens on the network and no tunnel is involved.
 *
 * TRUST MODEL (why there is NO token here): a stdio server can only be driven
 * by whoever spawned it — a local app running as the same user, i.e. the same
 * trust as the user's own terminal. TANDEM_TOKEN exists to gate the
 * NETWORK-exposed HTTP path (src/server.ts) and stays required there; it is
 * deliberately not required for stdio. The cwd allowlist is still enforced by
 * the router before every spawn, exactly as on the HTTP path.
 *
 * PROTOCOL HYGIENE: stdout is the JSON-RPC wire. Every diagnostic in this
 * process goes to stderr (the router/engine already follow this rule).
 */

// Desktop apps spawn this process from an arbitrary cwd, so locate .env next to
// package.json via the script's own path — never via process.cwd(). A missing
// .env is fine (the engine falls back to its $HOME-derived defaults).
import { fileURLToPath } from "node:url";
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env — defaults apply */
}

// Bridge the user-facing TANDEM_* config to the engine's CCM_* names. This MUST
// happen before importing the server module, which loads the router (and its
// cwd allowlist) at module load.
if (process.env.TANDEM_CWD_ALLOWLIST) process.env.CCM_CWD_ALLOWLIST = process.env.TANDEM_CWD_ALLOWLIST;
if (process.env.TANDEM_DEFAULT_CWD) process.env.CCM_DEFAULT_CWD = process.env.TANDEM_DEFAULT_CWD;

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { buildMcpServer } = await import("./mcp-server.ts");
const { getAllowlist } = await import("../bridge/router.ts");

const allowlist = getAllowlist();
if (allowlist.length === 0) {
  console.error(
    "⚠  cwd allowlist is empty — open_session/relay will refuse every directory.\n" +
      "   Set TANDEM_CWD_ALLOWLIST to the folders the bridge may work in.",
  );
}

// One long-lived server for the whole process (the SDK's stdio model), unlike
// the HTTP path's per-request instances. Session/relay state lives in the
// engine modules either way.
const server = buildMcpServer();
await server.connect(new StdioServerTransport());

console.error("tandem MCP bridge ready on stdio (local, no token)");
console.error(`cwd allowlist: ${allowlist.join(":") || "(empty — set TANDEM_CWD_ALLOWLIST)"}`);
