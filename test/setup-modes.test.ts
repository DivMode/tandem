import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const NODE_BIN = process.execPath;
const sandboxes: Sandbox[] = [];

const TS_SUCCESS = `#!/bin/sh
printf '%s\\n' "$*" >> "$TANDEM_TEST_TS_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"Self":{"DNSName":"synthetic-hub.example.ts.net."}}'
  exit 0
fi
if [ "$1" = "status" ]; then echo '100.64.0.1 synthetic-hub'; exit 0; fi
exit 0
`;

const TS_LOGGED_OUT = `#!/bin/sh
if [ "$1" = "status" ]; then echo 'Logged out.'; exit 1; fi
exit 0
`;

const TS_FUNNEL_FAILURE = `#!/bin/sh
printf '%s\\n' "$*" >> "$TANDEM_TEST_TS_LOG"
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then echo '{"Self":{"DNSName":"synthetic-hub.example.ts.net."}}'; exit 0; fi
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "funnel" ] && [ "$2" = "--bg" ]; then exit 1; fi
exit 0
`;

interface Sandbox {
  dir: string;
  home: string;
  publicPort: number;
  fleetPort: number;
  fleetHttpsPort: number;
}

function stubBinary(directory: string, name: string, body: string): void {
  const file = join(directory, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function makeSandbox(tailscale: string | null = TS_SUCCESS): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "tandem-setup-"));
  const home = mkdtempSync(join(tmpdir(), "tandem-setup-home-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  cpSync(join(REPO, "setup.sh"), join(dir, "setup.sh"));
  cpSync(join(REPO, "package.json"), join(dir, "package.json"));
  cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO, "bridge"), join(dir, "bridge"), { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  symlinkSync(NODE_BIN, join(bin, "node"));
  stubBinary(bin, "npm", "#!/bin/sh\nexit 0\n");
  stubBinary(bin, "tmux", "#!/bin/sh\nexit 0\n");
  stubBinary(bin, "claude", "#!/bin/sh\nexit 0\n");
  if (tailscale !== null) stubBinary(bin, "tailscale", tailscale);
  const offset = Math.floor(Math.random() * 8000);
  const sandbox = {
    dir,
    home,
    publicPort: 31000 + offset,
    fleetPort: 40000 + offset,
    fleetHttpsPort: 52000 + (offset % 8000),
  };
  sandboxes.push(sandbox);
  return sandbox;
}

function environment(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${join(sb.dir, "bin")}:/usr/bin:/bin`,
    HOME: sb.home,
    NODE_ENV: "test",
    TANDEM_SETUP_TEST_LOOPBACK: "1",
    TANDEM_SETUP_VERIFY_TRIES: "1",
    TANDEM_PORT: String(sb.publicPort),
    TANDEM_FLEET_PORT: String(sb.fleetPort),
    TANDEM_FLEET_HTTPS_PORT: String(sb.fleetHttpsPort),
    TANDEM_CWD_ALLOWLIST: sb.dir,
    TANDEM_TS_APP_BIN: join(sb.dir, "no-app"),
    TANDEM_TEST_TS_LOG: join(sb.dir, "tailscale.log"),
    ...extra,
  };
}

function runSetup(sb: Sandbox, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync("/bin/bash", [join(sb.dir, "setup.sh"), ...args], {
    cwd: sb.dir,
    env: environment(sb, extra),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function statePath(sb: Sandbox, ...parts: string[]): string {
  return join(sb.home, ".tandem", ...parts);
}

function config(sb: Sandbox, role: "hub" | "device"): Record<string, string> {
  return JSON.parse(readFileSync(statePath(sb, role, "config.json"), "utf8"));
}

function killPid(file: string): void {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (pid > 1) process.kill(pid, "SIGKILL");
  } catch {
    /* already stopped */
  }
}

function cleanup(sb: Sandbox): void {
  killPid(statePath(sb, "device", "device.pid"));
  killPid(statePath(sb, "hub", "hub.pid"));
  rmSync(sb.dir, { recursive: true, force: true });
  rmSync(sb.home, { recursive: true, force: true });
}

afterAll(() => {
  for (const sandbox of sandboxes) cleanup(sandbox);
});

describe("setup role selection", () => {
  it("defaults to the Tailscale hub and refuses removed Cloudflare modes", { timeout: 120_000 }, () => {
    const sb = makeSandbox();
    const hub = runSetup(sb, []);
    expect(hub.status).toBe(0);
    expect(hub.out).toContain("tandem setup: hub");

    const refused = makeSandbox();
    const quick = runSetup(refused, ["quick"]);
    expect(quick.status).not.toBe(0);
    expect(quick.out).toContain("Cloudflare quick tunnels and URL bearer tokens were removed");
    expect(existsSync(statePath(refused))).toBe(false);
  });

  it("rejects unknown roles and a missing allowlist before writing state", () => {
    const unknown = makeSandbox();
    expect(runSetup(unknown, ["mystery"]).status).not.toBe(0);

    const noAllowlist = makeSandbox();
    const result = runSetup(noAllowlist, ["hub"], { TANDEM_CWD_ALLOWLIST: "" });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("TANDEM_CWD_ALLOWLIST is required");
    expect(existsSync(statePath(noAllowlist))).toBe(false);
  });

  it("refuses state inside the repository and a symbolic-link state root", () => {
    const inside = makeSandbox();
    const insideResult = runSetup(inside, ["desktop"], { TANDEM_STATE_DIR: join(inside.dir, "runtime") });
    expect(insideResult.status).not.toBe(0);
    expect(insideResult.out).toContain("outside the repository");

    const linked = makeSandbox();
    const realState = join(linked.dir, "real-state");
    const linkedState = join(linked.home, "linked-state");
    mkdirSync(realState);
    symlinkSync(realState, linkedState);
    const linkedResult = runSetup(linked, ["desktop"], { TANDEM_STATE_DIR: linkedState });
    expect(linkedResult.status).not.toBe(0);
    expect(linkedResult.out).toContain("may not be symbolic links");
  });
});

describe("Tailscale hub setup", () => {
  it("creates OAuth and fleet state outside the repo without printing credentials", { timeout: 120_000 }, () => {
    const sb = makeSandbox();
    const result = runSetup(sb, ["hub"], { TANDEM_ENABLED_ENGINES: "codex" });
    expect(result.status).toBe(0);
    expect(result.out).toContain("Tandem hub is ready");
    expect(result.out).toContain("https://synthetic-hub.example.ts.net/mcp");
    expect(result.out).not.toContain("/mcp?");

    const hubConfig = config(sb, "hub");
    expect(hubConfig.TANDEM_PUBLIC_URL).toBe("https://synthetic-hub.example.ts.net/mcp");
    expect(hubConfig.TANDEM_FLEET_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(hubConfig.TANDEM_ENABLED_ENGINES).toBe("codex");
    expect(result.out).not.toContain(hubConfig.TANDEM_FLEET_TOKEN);
    const password = readFileSync(statePath(sb, "hub", "owner-password"), "utf8").trim();
    expect(password).toMatch(/^[a-f0-9]{64}$/);
    expect(result.out).not.toContain(password);

    const bundle = config(sb, "hub") && JSON.parse(readFileSync(statePath(sb, "hub", "device-enrollment.json"), "utf8"));
    expect(bundle.TANDEM_HUB_URL).toBe(`wss://synthetic-hub.example.ts.net:${sb.fleetHttpsPort}/`);
    expect(result.out).not.toContain(bundle.TANDEM_ENROLLMENT_TOKEN);
    expect(statSync(statePath(sb, "hub", "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(statePath(sb, "hub", "device-enrollment.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(sb.dir, ".env"))).toBe(false);

    const connector = JSON.parse(readFileSync(statePath(sb, "hub", "connector.json"), "utf8"));
    expect(connector).toEqual({ name: "tandem", url: "https://synthetic-hub.example.ts.net/mcp" });
    const commands = readFileSync(join(sb.dir, "tailscale.log"), "utf8");
    expect(commands).toContain(`funnel --bg ${sb.publicPort}`);
    expect(commands).toContain(`serve --bg --https=${sb.fleetHttpsPort} http://127.0.0.1:${sb.fleetPort}`);
    expect(commands).not.toContain(`funnel --bg ${sb.fleetPort}`);
  });

  it("is idempotent, preserves stable secrets, and revokes the superseded invitation", { timeout: 120_000 }, async () => {
    const sb = makeSandbox();
    expect(runSetup(sb, ["hub"]).status).toBe(0);
    const firstConfig = config(sb, "hub");
    const firstPassword = readFileSync(statePath(sb, "hub", "owner-password"), "utf8");
    const firstBundle = JSON.parse(readFileSync(statePath(sb, "hub", "device-enrollment.json"), "utf8"));

    const second = runSetup(sb, ["hub"]);
    expect(second.status).toBe(0);
    expect(second.out).toContain("already healthy");
    expect(config(sb, "hub").TANDEM_FLEET_TOKEN).toBe(firstConfig.TANDEM_FLEET_TOKEN);
    expect(readFileSync(statePath(sb, "hub", "owner-password"), "utf8")).toBe(firstPassword);
    const secondBundle = JSON.parse(readFileSync(statePath(sb, "hub", "device-enrollment.json"), "utf8"));
    expect(secondBundle.TANDEM_ENROLLMENT_TOKEN).not.toBe(firstBundle.TANDEM_ENROLLMENT_TOKEN);

    const replay = await fetch(`http://127.0.0.1:${sb.fleetPort}/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${firstBundle.TANDEM_ENROLLMENT_TOKEN}` },
    });
    expect(replay.status).toBe(401);

    const originalPid = readFileSync(statePath(sb, "hub", "hub.pid"), "utf8").trim();
    const changed = runSetup(sb, ["hub"], { TANDEM_ENABLED_ENGINES: "codex" });
    expect(changed.status).toBe(0);
    expect(changed.out).toContain("configuration changed");
    expect(config(sb, "hub").TANDEM_ENABLED_ENGINES).toBe("codex");
    expect(readFileSync(statePath(sb, "hub", "hub.pid"), "utf8").trim()).not.toBe(originalPid);
  });

  it("creates independent concurrent invitations without restarting or limiting enrolled devices", { timeout: 120_000 }, async () => {
    const sb = makeSandbox();
    expect(runSetup(sb, ["hub"]).status).toBe(0);
    const hubPid = readFileSync(statePath(sb, "hub", "hub.pid"), "utf8").trim();

    const first = runSetup(sb, ["invite"]);
    const second = runSetup(sb, ["invite"]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.out).toContain("device stays authorized and reconnects automatically");
    expect(second.out).toContain("device stays authorized and reconnects automatically");
    expect(readFileSync(statePath(sb, "hub", "hub.pid"), "utf8").trim()).toBe(hubPid);

    const invitationDirectory = statePath(sb, "hub", "invitations");
    const files = readdirSync(invitationDirectory).sort();
    expect(files).toHaveLength(2);
    const bundles = files.map((file) => JSON.parse(readFileSync(join(invitationDirectory, file), "utf8")));
    expect(bundles[0].TANDEM_ENROLLMENT_TOKEN).not.toBe(bundles[1].TANDEM_ENROLLMENT_TOKEN);
    expect(first.out).not.toContain(bundles[0].TANDEM_ENROLLMENT_TOKEN);
    expect(first.out).not.toContain(bundles[1].TANDEM_ENROLLMENT_TOKEN);
    expect(second.out).not.toContain(bundles[0].TANDEM_ENROLLMENT_TOKEN);
    expect(second.out).not.toContain(bundles[1].TANDEM_ENROLLMENT_TOKEN);

    for (const bundle of bundles) {
      const response = await fetch(`http://127.0.0.1:${sb.fleetPort}/enroll`, {
        method: "POST",
        headers: { authorization: `Bearer ${bundle.TANDEM_ENROLLMENT_TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).fleetToken).toBe(config(sb, "hub").TANDEM_FLEET_TOKEN);
    }
  });

  it("rolls back a newly started hub when Funnel configuration fails", { timeout: 120_000 }, () => {
    const sb = makeSandbox(TS_FUNNEL_FAILURE);
    const result = runSetup(sb, ["hub"]);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("Rolling back");
    expect(existsSync(statePath(sb, "hub", "hub.pid"))).toBe(false);
    expect(existsSync(statePath(sb, "hub", "provisioned"))).toBe(false);
  });
});

describe("device and desktop setup", () => {
  it("consumes a one-time bundle, registers the device, and retains no invitation", { timeout: 120_000 }, () => {
    const sb = makeSandbox();
    expect(runSetup(sb, ["hub"]).status).toBe(0);
    const bundleFile = statePath(sb, "hub", "device-enrollment.json");
    const bundle = JSON.parse(readFileSync(bundleFile, "utf8"));
    bundle.TANDEM_HUB_URL = `ws://127.0.0.1:${sb.fleetPort}/`;
    writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    chmodSync(bundleFile, 0o600);

    const enrolled = runSetup(sb, ["device", bundleFile], {
      TANDEM_ALLOW_LOOPBACK_ENROLLMENT: "1",
      TANDEM_DEVICE_ID: "device-test",
      TANDEM_DEVICE_NAME: "workstation",
      TANDEM_ENABLED_ENGINES: "",
    });
    expect(enrolled.status).toBe(0);
    expect(enrolled.out).toContain("Device registered with the hub");
    expect(enrolled.out).not.toContain(bundle.TANDEM_ENROLLMENT_TOKEN);
    expect(existsSync(bundleFile)).toBe(false);
    expect(existsSync(statePath(sb, "device", "ready"))).toBe(true);
    const deviceConfig = config(sb, "device");
    expect(deviceConfig.TANDEM_DEVICE_ID).toBe("device-test");
    expect(deviceConfig.TANDEM_DEVICE_NAME).toBe("workstation");
    expect(deviceConfig.TANDEM_FLEET_TOKEN).toBe(config(sb, "hub").TANDEM_FLEET_TOKEN);

    const rerun = runSetup(sb, ["device"], { TANDEM_ALLOW_LOOPBACK_ENROLLMENT: "1" });
    expect(rerun.status).toBe(0);
    expect(rerun.out).toContain("already registered and running");
  });

  it("writes a protected local stdio connector without Tailscale or network secrets", { timeout: 120_000 }, () => {
    const sb = makeSandbox(null);
    const result = runSetup(sb, ["desktop"]);
    expect(result.status).toBe(0);
    expect(result.out).toContain("No listener or tunnel was started");
    const connector = JSON.parse(readFileSync(statePath(sb, "desktop", "connector.json"), "utf8"));
    expect(connector.mcpServers.tandem.command).toBe("node");
    expect(connector.mcpServers.tandem.env.TANDEM_CONFIG_FILE).toBe(statePath(sb, "desktop", "config.json"));
    expect(readFileSync(statePath(sb, "desktop", "config.json"), "utf8")).not.toContain("TOKEN");
  });
});

describe("Tailscale prerequisite failures", () => {
  it("explains missing CLI and logged-out states without creating secrets", () => {
    const missing = makeSandbox(null);
    const missingResult = runSetup(missing, ["hub"]);
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.out).toContain("Tailscale is required");
    expect(existsSync(statePath(missing))).toBe(false);

    const loggedOut = makeSandbox(TS_LOGGED_OUT);
    const loggedOutResult = runSetup(loggedOut, ["hub"]);
    expect(loggedOutResult.status).not.toBe(0);
    expect(loggedOutResult.out).toContain("not logged in");
    expect(existsSync(statePath(loggedOut))).toBe(false);
  });
});
