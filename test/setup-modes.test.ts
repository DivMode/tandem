/**
 * setup.sh mode tests — run the REAL script in a throwaway sandbox with a
 * controlled PATH and stubbed external binaries (npm/tmux/claude/cloudflared/
 * tailscale), so every tailscale branch is exercised without a tailnet and
 * nothing ever touches the repo's own .env / .tandem.
 *
 * Two sandbox flavours:
 *   light — stub src/server.ts (a /health-only HTTP server) + stub
 *           src/stdio-server.ts: tests the SCRIPT's logic in isolation.
 *   full  — the real src/ + bridge/ (copied) + the repo's node_modules
 *           (symlinked): proves the desktop and quick paths still work
 *           against the real servers.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  chmodSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const NODE_BIN = process.execPath;

const EXPECTED_TOOLS = [
  "open_session",
  "list_sessions",
  "send_to_session",
  "interrupt_session",
  "close_session",
  "relay",
];

// ── stub binaries ────────────────────────────────────────────────────────────

const STUB_NOOP = "#!/bin/sh\nexit 0\n";

const STUB_CLOUDFLARED = `#!/bin/sh
echo "INF +--------------------------------------------------------------+"
echo "INF |  https://fake-quick-1234.trycloudflare.com                   |"
echo "INF +--------------------------------------------------------------+"
sleep 60
`;

/** tailscale stub: success — funnel prints the ts.net URL. */
const TS_SUCCESS = `#!/bin/sh
if [ "$1" = "status" ]; then
  if [ "$2" = "--json" ]; then echo '{"Self":{"DNSName":"fake-machine.tail1234.ts.net."}}'; else echo "100.64.0.1 fake-machine"; fi
  exit 0
fi
if [ "$1" = "funnel" ]; then
  echo "Available on the internet:"
  echo ""
  echo "https://fake-machine.tail1234.ts.net/"
  echo "|-- proxy http://127.0.0.1:8787"
  exit 0
fi
exit 0
`;

/** success, but funnel output carries NO URL → forces the status --json fallback. */
const TS_SUCCESS_NO_URL = `#!/bin/sh
if [ "$1" = "status" ]; then
  if [ "$2" = "--json" ]; then echo '{"Self":{"DNSName":"fallback-machine.tail9876.ts.net."}}'; else echo "100.64.0.1 fallback-machine"; fi
  exit 0
fi
if [ "$1" = "funnel" ]; then echo "Funnel started"; exit 0; fi
exit 0
`;

const TS_LOGGED_OUT = `#!/bin/sh
if [ "$1" = "status" ]; then echo "Logged out."; exit 1; fi
exit 0
`;

const TS_DAEMON_DOWN = `#!/bin/sh
if [ "$1" = "status" ]; then echo "failed to connect to local tailscaled; is Tailscale running?"; exit 1; fi
exit 0
`;

const TS_NO_FUNNEL_ATTR = `#!/bin/sh
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "funnel" ]; then
  echo 'Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel'
  exit 1
fi
exit 0
`;

const TS_HTTPS_OFF = `#!/bin/sh
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "funnel" ]; then
  echo 'Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https'
  exit 1
fi
exit 0
`;

// ── stub servers (light sandbox only) ───────────────────────────────────────

const STUB_HTTP_SERVER = `import http from "node:http";
const port = Number(process.env.TANDEM_PORT ?? 8787);
http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "tandem" }));
  })
  .listen(port, "127.0.0.1");
console.error("stub bridge listening on " + port);
`;

const STUB_STDIO_SERVER = `const tools = ${JSON.stringify(EXPECTED_TOOLS)}.map((name) => ({ name }));
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools } }));
  process.exit(0);
});
`;

// ── sandbox plumbing ─────────────────────────────────────────────────────────

interface Sandbox {
  dir: string;
  port: number;
}

const sandboxes: Sandbox[] = [];

function makeSandbox(opts: { tailscale?: string | null; full?: boolean } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "tandem-setup-test-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "home"));

  copyFileSync(join(REPO, "setup.sh"), join(dir, "setup.sh"));
  chmodSync(join(dir, "setup.sh"), 0o755);
  copyFileSync(join(REPO, ".env.example"), join(dir, ".env.example"));

  if (opts.full) {
    // Real servers: copied src/ + bridge/ resolve ../.env and ../bridge inside
    // the sandbox; node_modules is symlinked from the repo.
    copyFileSync(join(REPO, "package.json"), join(dir, "package.json"));
    cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO, "bridge"), join(dir, "bridge"), { recursive: true });
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  } else {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "server.ts"), STUB_HTTP_SERVER);
    writeFileSync(join(dir, "src", "stdio-server.ts"), STUB_STDIO_SERVER);
  }

  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  stub("npm", STUB_NOOP); // npm install is not under test; node_modules is real (full) or unused (light)
  stub("tmux", STUB_NOOP);
  stub("claude", STUB_NOOP);
  stub("cloudflared", STUB_CLOUDFLARED);
  if (opts.tailscale != null) stub("tailscale", opts.tailscale);
  symlinkSync(NODE_BIN, join(bin, "node"));

  const sb = { dir, port };
  sandboxes.push(sb);
  return sb;
}

function runSetup(sb: Sandbox, mode: string | undefined, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    // Pinned PATH: sandbox stubs + system coreutils only. Real tailscale /
    // cloudflared / tmux installs (brew etc.) are never on it.
    PATH: `${join(sb.dir, "bin")}:/usr/bin:/bin`,
    HOME: join(sb.dir, "home"),
    TANDEM_PORT: String(sb.port),
    TANDEM_TS_APP_BIN: join(sb.dir, "no-such-app"), // never fall back to a real /Applications binary
    TANDEM_FUNNEL_VERIFY_TRIES: "1", // fake ts.net hosts don't resolve — don't sit in the retry loop
    ...extraEnv,
  };
  if (mode !== undefined) env.TANDEM_SETUP_MODE = mode;
  const res = spawnSync("/bin/bash", [join(sb.dir, "setup.sh")], {
    env,
    encoding: "utf8",
    timeout: 90_000,
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function killPidFile(file: string) {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (pid > 1) process.kill(pid, "SIGKILL");
  } catch {
    /* not running / never written */
  }
}

function destroySandbox(sb: Sandbox) {
  killPidFile(join(sb.dir, ".tandem", "bridge.pid"));
  killPidFile(join(sb.dir, ".tandem", "tunnel.pid"));
  rmSync(sb.dir, { recursive: true, force: true });
}

afterAll(() => {
  for (const sb of sandboxes) destroySandbox(sb);
});

function readConnector(sb: Sandbox): { name: string; url: string } {
  return JSON.parse(readFileSync(join(sb.dir, ".tandem", "connector.json"), "utf8"));
}

function readToken(sb: Sandbox): string {
  const line = readFileSync(join(sb.dir, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("TANDEM_TOKEN="));
  return (line ?? "").slice("TANDEM_TOKEN=".length);
}

// ── mode selection ───────────────────────────────────────────────────────────

describe("setup.sh mode selection", () => {
  it("defaults to tailscale when no mode is given (non-interactive)", { timeout: 60_000 }, () => {
    const sb = makeSandbox({ tailscale: TS_SUCCESS });
    const { status, out } = runSetup(sb, undefined);
    expect(status).toBe(0);
    expect(out).toContain("mode: tailscale");
  });

  it("accepts q/quick, maps legacy 'web' to quick with a warning", { timeout: 60_000 }, () => {
    const sb = makeSandbox();
    const q = runSetup(sb, "q");
    expect(q.status).toBe(0);
    expect(q.out).toContain("mode: quick");
    killPidFile(join(sb.dir, ".tandem", "bridge.pid"));
    killPidFile(join(sb.dir, ".tandem", "tunnel.pid"));

    const sb2 = makeSandbox();
    const w = runSetup(sb2, "web");
    expect(w.status).toBe(0);
    expect(w.out).toContain("'web' is now called 'quick'");
    expect(w.out).toContain("mode: quick");
  });

  it("rejects an unknown mode before doing anything", () => {
    const sb = makeSandbox();
    const { status, out } = runSetup(sb, "garbage");
    expect(status).not.toBe(0);
    expect(out).toContain("unknown mode 'garbage'");
    expect(existsSync(join(sb.dir, ".env"))).toBe(false); // died before any side effect
  });
});

// ── tailscale: success paths ─────────────────────────────────────────────────

describe("setup.sh tailscale mode (stubbed CLI)", () => {
  it("parses the ts.net URL from funnel output and composes https://<host>/<token>/mcp", { timeout: 60_000 }, () => {
    const sb = makeSandbox({ tailscale: TS_SUCCESS });
    const { status, out } = runSetup(sb, "tailscale");
    expect(status).toBe(0);

    const token = readToken(sb);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const expectedUrl = `https://fake-machine.tail1234.ts.net/${token}/mcp`;
    expect(readConnector(sb).url).toBe(expectedUrl);
    expect(out).toContain(expectedUrl);
    expect(out).toContain("PERSISTENT");
    expect(readFileSync(join(sb.dir, ".tandem", "funnel.url"), "utf8").trim()).toBe(
      "https://fake-machine.tail1234.ts.net",
    );
  });

  it("falls back to `status --json` DNSName when funnel output has no URL", { timeout: 60_000 }, () => {
    const sb = makeSandbox({ tailscale: TS_SUCCESS_NO_URL });
    const { status } = runSetup(sb, "tailscale");
    expect(status).toBe(0);
    const token = readToken(sb);
    expect(readConnector(sb).url).toBe(`https://fallback-machine.tail9876.ts.net/${token}/mcp`);
  });

  it("re-running reuses the running bridge and prints the IDENTICAL URL", { timeout: 90_000 }, () => {
    const sb = makeSandbox({ tailscale: TS_SUCCESS });
    const first = runSetup(sb, "tailscale");
    expect(first.status).toBe(0);
    const urlFirst = readConnector(sb).url;

    const second = runSetup(sb, "tailscale");
    expect(second.status).toBe(0);
    expect(second.out).toContain("bridge already running");
    expect(second.out).toContain("using existing TANDEM_TOKEN");
    expect(readConnector(sb).url).toBe(urlFirst);
    expect(second.out).toContain(urlFirst);
  });
});

// ── tailscale: failure modes ─────────────────────────────────────────────────

describe("setup.sh tailscale failure modes (stubbed CLI)", () => {
  it("CLI missing → per-OS install guidance incl. the macOS App-Store/standalone warning", () => {
    const sb = makeSandbox({ tailscale: null });
    const { status, out } = runSetup(sb, "tailscale");
    expect(status).not.toBe(0);
    expect(out).toContain("tailscale is not installed");
    expect(out).toContain("brew install --cask tailscale-app");
    expect(out).toContain("Mac App Store version of Tailscale cannot run");
    expect(out).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
  });

  it("not logged in → instructs `tailscale up` and exits", () => {
    const sb = makeSandbox({ tailscale: TS_LOGGED_OUT });
    const { status, out } = runSetup(sb, "tailscale");
    expect(status).not.toBe(0);
    expect(out).toContain("not logged in");
    expect(out).toContain("tailscale up");
  });

  it("daemon not running → per-OS start instructions", () => {
    const sb = makeSandbox({ tailscale: TS_DAEMON_DOWN });
    const { status, out } = runSetup(sb, "tailscale");
    expect(status).not.toBe(0);
    expect(out).toContain("daemon isn't running");
    expect(out).toContain("systemctl start tailscaled");
  });

  it("funnel not permitted by tailnet policy → enable-link guidance", { timeout: 60_000 }, () => {
    const sb = makeSandbox({ tailscale: TS_NO_FUNNEL_ATTR });
    const { status, out } = runSetup(sb, "tailscale");
    expect(status).not.toBe(0);
    expect(out).toContain("doesn't permit Funnel");
    expect(out).toContain("tailscale.com/kb/1223/funnel");
    expect(out).toContain("tailscale.com/s/no-funnel"); // raw tailscale output surfaced
  });

  it("HTTPS certs disabled → admin-console fix link (matched BEFORE the generic funnel error)", { timeout: 60_000 }, () => {
    const sb = makeSandbox({ tailscale: TS_HTTPS_OFF });
    const { status, out } = runSetup(sb, "tailscale");
    expect(status).not.toBe(0);
    expect(out).toContain("HTTPS certificates are disabled");
    expect(out).toContain("login.tailscale.com/admin/dns");
    expect(out).not.toContain("doesn't permit Funnel"); // the HTTPS case must win the match
  });
});

// ── regression: desktop + quick unchanged ────────────────────────────────────

describe("setup.sh desktop & quick paths (regression)", () => {
  it("desktop (FULL fidelity): real stdio server answers the smoke test, no token written", { timeout: 120_000 }, () => {
    const sb = makeSandbox({ full: true });
    const { status, out } = runSetup(sb, "desktop");
    expect(status).toBe(0);
    expect(out).toContain("stdio server answers with all 6 tools");
    expect(out).toContain("no tunnel, no token");
    const connector = JSON.parse(
      readFileSync(join(sb.dir, ".tandem", "desktop-connector.json"), "utf8"),
    );
    expect(connector.mcpServers.tandem.args[1]).toBe(join(sb.dir, "src/stdio-server.ts"));
    expect(readToken(sb)).toBe(""); // desktop stays tokenless
  });

  it("quick (FULL fidelity): real bridge + stubbed cloudflared → trycloudflare MCP URL", { timeout: 120_000 }, () => {
    const sb = makeSandbox({ full: true });
    const { status, out } = runSetup(sb, "quick");
    expect(status).toBe(0);
    const token = readToken(sb);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readConnector(sb).url).toBe(`https://fake-quick-1234.trycloudflare.com/${token}/mcp`);
    expect(out).toContain("tandem is live (quick tunnel)");
    expect(out).toContain("Keep this terminal open");
  });
});
