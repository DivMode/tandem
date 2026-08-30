import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TerminalBackend } from "../bridge/terminal-backend.ts";
import type { DrivableSession, EngineId } from "../bridge/drivable.ts";

/**
 * SEAM test for the Fable consent flag. test/model-routing.test.ts already
 * proves the router's gate; this file proves the flag actually SURVIVES the
 * journey to it — MCP tool input → the tool's zod schema → dispatchSessionOp →
 * executeLocalOp → router. Every hop in that chain drops unknown fields (the
 * MCP schema strips them, the fleet payload schemas are `.strict()`, and the op
 * table names fields explicitly), so a plumbing gap anywhere would silently
 * turn a consented Fable request into a permanent 400 the user could never
 * satisfy. A gate nobody can pass is as broken as a gate nobody has to.
 *
 * NOTHING REAL IS STARTED. The terminal backend is replaced with one whose
 * spawn() throws, and the "live" session is a fake DrivableSession seeded into
 * the same registry the router reads — so no tmux session, no Herdr workspace,
 * and no engine process is ever created.
 */

const backend: TerminalBackend = {
  kind: "tmux",
  spawn: async () => {
    throw new Error("no session may be spawned by this suite");
  },
  attachExisting: async () => undefined,
  exists: async () => false,
  engineTagOf: async () => undefined,
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

vi.mock("../bridge/terminal-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge/terminal-backend.ts")>();
  return { ...actual, terminalBackend: backend };
});

const { buildMcpServer } = await import("../src/mcp-server.ts");
const { registerLive, unregisterLive } = await import("../bridge/sessions.ts");
const { executeLocalOp } = await import("../bridge/fleet-op-table.ts");
const { FABLE_CONSENT_FIELD, FABLE_ALIAS, FABLE_FULL_MODEL_ID } = await import("../bridge/model-policy.ts");

/** Controls each fake session actually received, in order. */
const received = new Map<string, Array<{ model?: string; effort?: string }>>();

const opened: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  for (const name of opened.splice(0)) unregisterLive(name);
  received.clear();
});

let counter = 0;

function seedLive(engine: EngineId = "claude"): string {
  const name = `seam-${engine}-${(counter += 1)}`;
  const log: Array<{ model?: string; effort?: string }> = [];
  received.set(name, log);
  const session: DrivableSession = {
    id: name,
    engine,
    cwd: "/tmp",
    isAlive: async () => true,
    isWorking: async () => false,
    send: async (_text, controls) => {
      log.push({ model: controls?.model, effort: controls?.effort });
      return { status: "done", report: "ok", cursor: 1 };
    },
    read: async () => ({ text: "", cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => "fake-attach-hint",
  };
  registerLive(session);
  opened.push(name);
  return name;
}

async function mcpClient() {
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

const bodyOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text) as Record<string, unknown>;

describe("consent survives the MCP → dispatch → router seam (send_to_session)", () => {
  for (const model of [FABLE_ALIAS, FABLE_FULL_MODEL_ID]) {
    it(`delivers "${model}" to the session when ${FABLE_CONSENT_FIELD} is true`, async () => {
      const name = seedLive();
      const client = await mcpClient();
      const result = await client.callTool({
        name: "send_to_session",
        arguments: { name, text: "go", model, [FABLE_CONSENT_FIELD]: true },
      });
      const body = bodyOf(result);
      expect(body.error, `consent was lost in transit: ${JSON.stringify(body)}`).toBeUndefined();
      expect(body.status).toBe("done");
      // The gate did not merely allow the call — the model actually arrived.
      expect(received.get(name)).toEqual([{ model, effort: undefined }]);
    });

    it(`denies "${model}" through MCP when ${FABLE_CONSENT_FIELD} is absent`, async () => {
      const name = seedLive();
      const client = await mcpClient();
      const body = bodyOf(
        await client.callTool({ name: "send_to_session", arguments: { name, text: "go", model } }),
      );
      expect(String(body.error)).toMatch(/explicit-user-only/);
      expect(received.get(name)).toEqual([]);
    });

    it(`denies "${model}" through MCP when ${FABLE_CONSENT_FIELD} is false`, async () => {
      const name = seedLive();
      const client = await mcpClient();
      const body = bodyOf(
        await client.callTool({
          name: "send_to_session",
          arguments: { name, text: "go", model, [FABLE_CONSENT_FIELD]: false },
        }),
      );
      expect(String(body.error)).toMatch(/explicit-user-only/);
      expect(received.get(name)).toEqual([]);
    });
  }

  it("carries consent through the DEVICE-side entrypoint too (executeLocalOp, what a fleet device runs)", async () => {
    const name = seedLive();
    const granted = await executeLocalOp("send", {
      sessionId: name,
      text: "go",
      model: FABLE_ALIAS,
      user_requested_fable: true,
    });
    expect(granted.status).toBe(200);
    expect(received.get(name)).toEqual([{ model: FABLE_ALIAS, effort: undefined }]);

    const denied = await executeLocalOp("send", { sessionId: name, text: "go", model: FABLE_ALIAS });
    expect(denied.status).toBe(400);
    // Still just the one delivered turn — the denied call sent nothing.
    expect(received.get(name)).toHaveLength(1);
  });

  it("open_session exposes and forwards the flag through the same seam (rejected before any spawn)", async () => {
    const client = await mcpClient();
    // The backend's spawn() throws, so reaching it would surface as a 500.
    // A clean 400 proves the flag was carried and the gate ran first.
    const body = bodyOf(
      await client.callTool({ name: "open_session", arguments: { name: "seam-open", model: FABLE_ALIAS } }),
    );
    expect(String(body.error)).toMatch(/explicit-user-only/);
  });
});

describe("the consent flag is Claude-only, not silently ignored", () => {
  it("rejects it on send_to_session for a non-Claude session instead of accepting it", async () => {
    const name = seedLive("shell");
    const client = await mcpClient();
    const body = bodyOf(
      await client.callTool({
        name: "send_to_session",
        arguments: { name, text: "ls", [FABLE_CONSENT_FIELD]: true },
      }),
    );
    expect(String(body.error)).toMatch(new RegExp(`${FABLE_CONSENT_FIELD} is a Claude-only option`));
    expect(received.get(name)).toEqual([]);
  });
});

describe("malformed consent is diagnosed regardless of which other fields are present", () => {
  it('rejects the STRING "true" on send_to_session even when no model or effort is supplied', async () => {
    const name = seedLive();
    const { routeForTest } = await import("../bridge/router.ts");
    // Sent through the router directly: the MCP schema is typed boolean, so a
    // string cannot reach the router from a well-behaved client — but a fleet
    // hop, a legacy caller, or a hand-rolled HTTP client can, and a malformed
    // consent claim must never be inert on one shape of call and fatal on another.
    const res = await routeForTest("POST", `/sessions/${name}/send`, {
      text: "go",
      [FABLE_CONSENT_FIELD]: "true",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must be a boolean/);
    expect(received.get(name)).toEqual([]);
  });

  it('rejects the STRING "true" in poll mode too (empty text), rather than passing silently', async () => {
    const name = seedLive();
    const { routeForTest } = await import("../bridge/router.ts");
    const res = await routeForTest("POST", `/sessions/${name}/send`, {
      text: "",
      [FABLE_CONSENT_FIELD]: "true",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must be a boolean/);
  });

  it("leaves a well-formed poll untouched: consent is inert when no model is being selected", async () => {
    const name = seedLive();
    const { routeForTest } = await import("../bridge/router.ts");
    const res = await routeForTest("POST", `/sessions/${name}/send`, {
      text: "",
      cursor: 0,
      [FABLE_CONSENT_FIELD]: true,
    });
    // The polling protocol the instructions tell clients to use must keep working.
    expect(res.status).toBe(200);
    expect(received.get(name)).toEqual([]);
  });

  it("rejects a non-boolean flag on open_session as well", async () => {
    const { routeForTest } = await import("../bridge/router.ts");
    const res = await routeForTest("POST", "/sessions/open", {
      name: "seam-open-malformed",
      model: FABLE_ALIAS,
      [FABLE_CONSENT_FIELD]: 1,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must be a boolean/);
  });
});
