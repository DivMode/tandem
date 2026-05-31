/**
 * tandem — entrypoint
 *
 * Starts the local MCP bridge that a chat AI (Claude.ai) reaches through YOUR
 * OWN cloudflared quick tunnel. Everything sensitive comes from the environment
 * (.env) — there are no secrets in this repo.
 *
 * Security model (do not weaken):
 *   - TANDEM_TOKEN is REQUIRED. Without it the server refuses to start.
 *   - Every request must present that token (Bearer header, ?token=, or path).
 *   - Sessions may only be opened inside the cwd allowlist (TANDEM_CWD_ALLOWLIST).
 *
 * The token check runs BEFORE any heavy/optional dependency is imported, so
 * `TANDEM_TOKEN= node --experimental-strip-types src/server.ts` fails fast with
 * instructions even before `npm install`.
 */

const TOKEN = (process.env.TANDEM_TOKEN ?? "").trim();

if (!TOKEN) {
  console.error(
    [
      "",
      "✗ tandem will not start: TANDEM_TOKEN is not set.",
      "",
      "  The bridge runs real commands on this machine, so it must never be",
      "  exposed without a secret token.",
      "",
      "  Fix it one of these ways:",
      "    • Run the setup script (recommended):   ./setup.sh",
      "    • Or set it yourself:                    export TANDEM_TOKEN=$(openssl rand -hex 32)",
      "    • Or put TANDEM_TOKEN=... in a .env file next to package.json",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (TOKEN.length < 16) {
  console.error(
    "✗ TANDEM_TOKEN is too short to be safe (need >= 16 chars). " +
      "Generate one with: openssl rand -hex 32",
  );
  process.exit(1);
}

// Bridge the user-facing TANDEM_* config to the engine's CCM_* names. This MUST
// happen before importing the engine, which reads them at module load.
if (process.env.TANDEM_CWD_ALLOWLIST) process.env.CCM_CWD_ALLOWLIST = process.env.TANDEM_CWD_ALLOWLIST;
if (process.env.TANDEM_DEFAULT_CWD) process.env.CCM_DEFAULT_CWD = process.env.TANDEM_DEFAULT_CWD;

// Token is present and sane. Now load the rest (these import external deps).
const { startServer } = await import("./http-mcp.ts");

await startServer({
  token: TOKEN,
  port: Number(process.env.TANDEM_PORT ?? 8787),
  host: process.env.TANDEM_HOST ?? "127.0.0.1",
});
