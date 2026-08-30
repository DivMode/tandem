import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.ts";

// The ONE tool surface shared by both transports (HTTP and stdio). If either
// transport's view of the tools drifts, this locks it down.
const EXPECTED_TOOLS = [
  "open_session",
  "list_sessions",
  "send_to_session",
  "interrupt_session",
  "close_session",
  "relay",
  // Phase 3: list_devices is always registered (returns an empty device list
  // when no fleet runtime is supplied — see test/fleet/mcp-schema.test.ts).
  "list_devices",
  // Orchestration bootstrap: read-only policy tool (see
  // test/orchestration-policy.test.ts for its annotations and content).
  "get_orchestration_policy",
  // Foreman reconciliation: read-only durable event feed (see
  // test/foreman-events.test.ts for its annotations, surface, and redaction).
  "get_foreman_events",
];

describe("buildMcpServer (shared tool surface)", () => {
  it("registers exactly the 9 tools (6 consolidated + list_devices + get_orchestration_policy + get_foreman_events)", async () => {
    const server = buildMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());

    await client.close();
    await server.close();
  });

  // Phase 2: open_session gained an optional `engine` field without changing
  // the tool count/names above (binding — Phase 2 outline: "do not change the
  // number or names of MCP tools").
  it("open_session exposes an optional engine enum: claude|codex|shell|hermes", async () => {
    const server = buildMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const openSession = tools.find((t) => t.name === "open_session");
    expect(openSession).toBeDefined();
    const props = (openSession!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const engineProp = props["engine"] as { enum?: string[] } | undefined;
    expect(engineProp?.enum?.slice().sort()).toEqual(["claude", "codex", "hermes", "shell"]);

    // engine must not be required (defaults to claude).
    const required = (openSession!.inputSchema as { required?: string[] }).required ?? [];
    expect(required).not.toContain("engine");

    await client.close();
    await server.close();
  });
});
