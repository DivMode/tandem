import { describe, it, expect, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * The MCP-visible half of the orchestration bootstrap: what a connected client
 * can actually LEARN from this server. Three surfaces, one canonical source
 * (src/orchestration-policy.ts):
 *
 *   1. the `initialize` result's `instructions` (server-level hint),
 *   2. concise per-tool guidance inside the tool descriptions,
 *   3. the read-only `get_orchestration_policy` tool.
 *
 * These assertions are about the CONTENT reaching a client, not about
 * formatting: each one names a rule a client would behave differently without.
 *
 * The router half (default Opus actually reaching spawn, and the Fable gate
 * actually rejecting) is proven separately in test/model-routing.test.ts —
 * asserting text here would only prove the text exists.
 *
 * router.ts's audit() appends to the real ~/.tandem/bridge.log on import; stub
 * the three node:fs calls it uses so this suite never touches real home state.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const { buildMcpServer } = await import("../src/mcp-server.ts");
const { ORCHESTRATION_INSTRUCTIONS, ORCHESTRATION_POLICY, ORCHESTRATION_POLICY_VERSION } = await import(
  "../src/orchestration-policy.ts"
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

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

describe("initialize instructions", () => {
  it("returns the canonical orchestration instructions in the initialize result", async () => {
    const client = await connectedClient();
    expect(client.getInstructions()).toBe(ORCHESTRATION_INSTRUCTIONS);
  });

  it("names the three roles: client as foreman, GitHub as durable truth, Tandem as execution/session bus", async () => {
    const client = await connectedClient();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/foreman/i);
    expect(instructions).toMatch(/GitHub/);
    expect(instructions).toMatch(/durable truth/i);
    expect(instructions).toMatch(/execution and session bus/i);
  });

  it("tells a client to list and reuse sessions before opening a duplicate", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/list_sessions BEFORE open_session/i);
    expect(instructions).toMatch(/reuse/i);
    expect(instructions).toMatch(/duplicate/i);
  });

  it("states that interrupting the client does not stop in-flight workers, so re-list and resume the same one", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/does NOT stop in-flight Tandem work/i);
    expect(instructions).toMatch(/resume the SAME worker/i);
  });

  it("states the running+cursor polling protocol and forbids resending", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/running/);
    expect(instructions).toMatch(/empty text/i);
    expect(instructions).toMatch(/cursor/);
    expect(instructions).toMatch(/NEVER resend/i);
  });

  it("states the model-routing defaults and the explicit-user-only Fable rule", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/default to the "opus" alias/i);
    expect(instructions).toMatch(/sonnet/);
    expect(instructions).toMatch(/haiku/);
    expect(instructions).toMatch(/EXPLICIT-USER-ONLY/);
    expect(instructions).toMatch(/user_requested_fable/);
    expect(instructions).toMatch(/Never infer it/i);
  });

  it("is versioned", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toContain(`v${ORCHESTRATION_POLICY_VERSION}`);
  });
});

describe("get_orchestration_policy tool", () => {
  it("is annotated read-only, non-destructive, idempotent, closed-world", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_orchestration_policy");
    expect(tool).toBeDefined();
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("takes no required input", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_orchestration_policy")!;
    expect((tool.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });

  it("returns the full versioned policy, the instructions, and the MAY-use note", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_orchestration_policy", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as {
      version: string;
      policy: typeof ORCHESTRATION_POLICY;
      instructions: string;
      note: string;
    };

    expect(parsed.version).toBe(ORCHESTRATION_POLICY_VERSION);
    // Full policy, not a summary — the same object the instructions derive from.
    expect(parsed.policy).toEqual(ORCHESTRATION_POLICY);
    expect(parsed.instructions).toBe(ORCHESTRATION_INSTRUCTIONS);
    // MCP initialize instructions are a client-consumption hint (MAY be used).
    expect(parsed.note).toMatch(/hint/i);
    expect(parsed.note).toMatch(/MAY use it/);
    expect(parsed.note).toMatch(/enforced by this server regardless/i);

    // Model routing is carried structurally, not only as prose.
    expect(parsed.policy.modelRouting.defaultModel).toBe("opus");
    expect(parsed.policy.modelRouting.fable.alias).toBe("fable");
    expect(parsed.policy.modelRouting.fable.fullModelId).toBe("claude-fable-5");
    expect(parsed.policy.modelRouting.fable.consentField).toBe("user_requested_fable");
  });

  it("does not open, change, or touch any session (declared read-only and callable with no live session)", async () => {
    const client = await connectedClient();
    const before = await client.callTool({ name: "list_sessions", arguments: {} });
    await client.callTool({ name: "get_orchestration_policy", arguments: {} });
    const after = await client.callTool({ name: "list_sessions", arguments: {} });
    expect(after.content).toEqual(before.content);
  });
});

describe("tool descriptions carry the complementary guidance", () => {
  async function descriptions() {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.description ?? ""]));
  }

  it("list_sessions: reuse before opening, and re-list after an interruption", async () => {
    const d = (await descriptions()).get("list_sessions")!;
    expect(d).toMatch(/BEFORE open_session/);
    expect(d).toMatch(/duplicate/i);
    expect(d).toMatch(/interruption/i);
    expect(d).toMatch(/survives the client stopping/i);
  });

  it("open_session: list first, reuse is idempotent, and the model-routing ladder", async () => {
    const d = (await descriptions()).get("open_session")!;
    expect(d).toMatch(/list_sessions first/i);
    expect(d).toMatch(/reused: true/);
    expect(d).toMatch(/"opus" default/);
    expect(d).toMatch(/sonnet/);
    expect(d).toMatch(/haiku only for trivial/i);
  });

  it("send_to_session: running+cursor means poll the same session, never resend", async () => {
    const d = (await descriptions()).get("send_to_session")!;
    expect(d).toMatch(/STILL EXECUTING/);
    expect(d).toMatch(/empty text and that cursor/);
    expect(d).toMatch(/NEVER resend/);
    expect(d).toMatch(/Interrupting the client does not stop this turn/i);
  });

  it("the Fable consent field is described as explicit-user-only on both open_session and send_to_session", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const name of ["open_session", "send_to_session"]) {
      const tool = tools.find((t) => t.name === name)!;
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      const field = props["user_requested_fable"];
      expect(field, `${name} must expose user_requested_fable`).toBeDefined();
      expect(field!.description).toMatch(/ONLY when the user's current instruction explicitly requested Fable/);
      expect(field!.description).toMatch(/Never infer it/);
      // Never required — the gate is opt-in, not a field every call must send.
      expect((tool.inputSchema as { required?: string[] }).required ?? []).not.toContain("user_requested_fable");
    }
  });
});
