import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The MCP-visible surface of the foreman event feed, exercised over a real
 * in-memory client/server pair — no HTTP, no stdio subprocess, no engine.
 *
 * router.ts's audit() and the event sinks write under Tandem's state root, so
 * TANDEM_STATE_DIR is redirected to a temp directory for every test here.
 */

const roots: string[] = [];
let stateDir: string;
const previousStateDir = process.env.TANDEM_STATE_DIR;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tandem-mcp-foreman-"));
  roots.push(stateDir);
  process.env.TANDEM_STATE_DIR = stateDir;
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  if (previousStateDir === undefined) delete process.env.TANDEM_STATE_DIR;
  else process.env.TANDEM_STATE_DIR = previousStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const { buildMcpServer } = await import("../src/mcp-server.ts");
const { ORCHESTRATION_INSTRUCTIONS, ORCHESTRATION_POLICY, ORCHESTRATION_POLICY_VERSION } = await import(
  "../src/orchestration-policy.ts"
);

async function connectedClient() {
  const server = buildMcpServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("get_foreman_events tool surface", () => {
  it("is annotated read-only, non-destructive, idempotent, closed-world", async () => {
    const { tools } = await (await connectedClient()).listTools();
    const tool = tools.find((t) => t.name === "get_foreman_events");
    expect(tool).toBeDefined();
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("carries NO blast-radius warning: it drives nothing", async () => {
    const { tools } = await (await connectedClient()).listTools();
    const description = tools.find((t) => t.name === "get_foreman_events")!.description ?? "";
    expect(description).not.toMatch(/WARNING: this controls a REAL interactive engine session/);
    // The two session-driving tools still carry it, so the warning stays meaningful.
    for (const name of ["open_session", "send_to_session"]) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/WARNING: this controls a REAL/);
    }
  });

  it("takes no required input and exposes since + limit + device", async () => {
    const { tools } = await (await connectedClient()).listTools();
    const tool = tools.find((t) => t.name === "get_foreman_events")!;
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.required ?? []).toEqual([]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["device", "limit", "since"]);
  });

  it("explains one-device-per-call and the more/truncated distinction", async () => {
    const { tools } = await (await connectedClient()).listTools();
    const description = tools.find((t) => t.name === "get_foreman_events")!.description ?? "";
    expect(description).toMatch(/each device keeps its own events/i);
    expect(description).toMatch(/never reads more than one device/i);
    expect(description).toMatch(/list_devices/);
    expect(description).toMatch(/`more: true` means unread events remain/i);
    expect(description).toMatch(/`truncated: true` is different and worse/i);
  });

  it("issues an fe2 map checkpoint that records the device it read", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_foreman_events", arguments: {} });
    const page = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      checkpoint: string;
      device: string;
    };
    expect(page.device).toBe("local");
    expect(page.checkpoint.startsWith("fe2_")).toBe(true);
    const decoded = JSON.parse(Buffer.from(page.checkpoint.slice(4), "base64url").toString("utf8"));
    expect(decoded.v).toBe(2);
    expect(Object.keys(decoded.d)).toEqual(["local"]);
  });

  it("names an unknown device explicitly instead of silently returning nothing", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_foreman_events", arguments: { device: "nosuch" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/nosuch/);
    expect(text).toMatch(/not online/i);
  });

  it("states that it is history and list_sessions is liveness", async () => {
    const { tools } = await (await connectedClient()).listTools();
    const description = tools.find((t) => t.name === "get_foreman_events")!.description ?? "";
    expect(description).toMatch(/HISTORY, NOT LIVENESS/i);
    expect(description).toMatch(/list_sessions is the only liveness truth/i);
    expect(description).toMatch(/checkpoint/i);
    expect(description).toMatch(/truncated/i);
  });

  it("returns a well-formed page on an empty store and does not ack by listing", async () => {
    const client = await connectedClient();
    const first = await client.callTool({ name: "get_foreman_events", arguments: {} });
    const second = await client.callTool({ name: "get_foreman_events", arguments: {} });
    const parse = (r: typeof first) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

    const page = parse(first);
    expect(page.events).toEqual([]);
    expect(page.more).toBe(false);
    expect(typeof page.checkpoint).toBe("string");
    // Listing must never mark anything read: the same call twice is identical.
    expect(parse(second)).toEqual(page);
  });

  it("does not open, change, or touch any session", async () => {
    const client = await connectedClient();
    const before = await client.callTool({ name: "list_sessions", arguments: {} });
    await client.callTool({ name: "get_foreman_events", arguments: {} });
    const after = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(after.content).toEqual(before.content);
  });

  it("surfaces a malformed checkpoint as an error rather than silently restarting", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_foreman_events", arguments: { since: "garbage" } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/checkpoint/i);
  });
});

describe("no acknowledgement tool exists", () => {
  it("does not register ack_foreman_events (checkpoints are carried by the client)", async () => {
    const { tools } = await (await connectedClient()).listTools();
    expect(tools.map((t) => t.name)).not.toContain("ack_foreman_events");
    // Nothing in the surface offers a server-side global read watermark.
    expect(tools.filter((t) => /ack/i.test(t.name))).toEqual([]);
  });
});

describe("initialize instructions tell a foreman to reconcile", () => {
  it("names both calls, before opening anything", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/RECONCILE/);
    expect(instructions).toMatch(/get_foreman_events/);
    expect(instructions).toMatch(/list_sessions/);
    expect(instructions).toMatch(/BEFORE opening anything/i);
    expect(instructions).toMatch(/interruption, reconnect, or context loss/i);
  });

  it("distinguishes history from liveness and puts the checkpoint on the client", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/history/i);
    expect(instructions).toMatch(/liveness/i);
    expect(instructions).toMatch(/checkpoint/i);
    expect(instructions).toMatch(/the server does not remember what you have read/i);
  });

  it("does not promise that anything can wake a dormant conversation", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/No MCP server can wake a dormant conversation/i);
  });

  it("is versioned, and the version moved past the PR #3 bootstrap", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toContain(`v${ORCHESTRATION_POLICY_VERSION}`);
    expect(ORCHESTRATION_POLICY_VERSION).not.toBe("1.0.0");
  });
});

describe("PR #3 orchestration and model policy is preserved", () => {
  it("still names the three roles and the session-reuse discipline", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/foreman/i);
    expect(instructions).toMatch(/GitHub/);
    expect(instructions).toMatch(/durable truth/i);
    expect(instructions).toMatch(/execution and session bus/i);
    expect(instructions).toMatch(/list_sessions BEFORE open_session/i);
    expect(instructions).toMatch(/does NOT stop in-flight Tandem work/i);
    expect(instructions).toMatch(/NEVER resend/i);
  });

  it("still states the Opus default and the explicit-user-only Fable gate", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/default to the "opus" alias/i);
    expect(instructions).toMatch(/EXPLICIT-USER-ONLY/);
    expect(instructions).toMatch(/user_requested_fable/);
    expect(ORCHESTRATION_POLICY.modelRouting.defaultModel).toBe("opus");
    expect(ORCHESTRATION_POLICY.modelRouting.fable.alias).toBe("fable");
  });

  it("serves the reconciliation rules through get_orchestration_policy, structurally", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_orchestration_policy", arguments: {} });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      version: string;
      policy: typeof ORCHESTRATION_POLICY;
      instructions: string;
    };
    expect(parsed.version).toBe(ORCHESTRATION_POLICY_VERSION);
    expect(parsed.policy).toEqual(ORCHESTRATION_POLICY);
    expect(parsed.instructions).toBe(ORCHESTRATION_INSTRUCTIONS);
    // The detailed explanation lives here, behind the tool, not in the compact
    // initialize hint.
    expect(parsed.policy.reconciliation.length).toBeGreaterThan(3);
    expect(parsed.policy.reconciliation.join(" ")).toMatch(/stateless/i);
  });
});

describe("stdio smoke (same nine-tool surface, no subprocess)", () => {
  it("builds and serves the identical tool set the HTTP transport exposes", async () => {
    // buildMcpServer is the single surface both entrypoints construct; proving
    // it here covers stdio without spawning a real Claude or Herdr process.
    const spy = vi.spyOn(globalThis, "fetch");
    const { tools } = await (await connectedClient()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "close_session",
        "get_foreman_events",
        "get_orchestration_policy",
        "interrupt_session",
        "list_devices",
        "list_sessions",
        "open_session",
        "relay",
        "send_to_session",
      ].sort(),
    );
    expect(spy).not.toHaveBeenCalled(); // nothing reached the network
    spy.mockRestore();
  });
});
