/**
 * Exercises the production wiring pieces src/server.ts assembles (binding —
 * Phase 3 correction 7): a public HTTP MCP server and a private fleet
 * listener started independently, in the same process, sharing one
 * FleetRuntime — never merged into a single router, and the public side
 * keeps working untouched when no fleet token is configured.
 *
 * src/server.ts itself is a top-level-await script (not importable in a
 * test), so this exercises the same building blocks it wires together:
 * bridge/fleet-runtime.ts, bridge/fleet-private-server.ts, and
 * src/http-mcp.ts's startServer().
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const { assertPublicLoopbackHost, startServer } = await import("../../src/http-mcp.ts");
const { createFleetRuntime, buildDefaultDeviceIdFromEnv } = await import("../../bridge/fleet-runtime.ts");
const { startPrivateFleetServer } = await import("../../bridge/fleet-private-server.ts");

const FLEET_TOKEN = "production-wiring-test-token-0123456789";
const PUBLIC_TOKEN = "production-wiring-public-token-0123456789";

type Closeable = { close(): Promise<void> };
const cleanups: Closeable[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c.close();
});

describe("production wiring: public server with no fleet token", () => {
  it("rejects a non-loopback public bind and a short token before listening", async () => {
    expect(() => assertPublicLoopbackHost("0.0.0.0")).toThrow(/loopback/);
    expect(() => assertPublicLoopbackHost("127.0.0.1")).not.toThrow();
    await expect(startServer({ token: PUBLIC_TOKEN, port: 0, host: "0.0.0.0" })).rejects.toThrow(/loopback/);
    await expect(startServer({ token: "too-short", port: 0, host: "127.0.0.1" })).rejects.toThrow(/at least 16/);
    await expect(startServer({ token: PUBLIC_TOKEN, port: 70_000, host: "127.0.0.1" })).rejects.toThrow(/port/);
  });

  it("still listens and serves its health check with no fleet runtime supplied", async () => {
    const publicHandle = await startServer({ token: PUBLIC_TOKEN, port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${publicHandle.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "tandem" });
    await publicHandle.close();
  });

  it("rejects unauthenticated, malformed, and oversized MCP requests with bounded errors", async () => {
    const publicHandle = await startServer({ token: PUBLIC_TOKEN, port: 0, host: "127.0.0.1" });
    cleanups.push(publicHandle);
    const url = `http://127.0.0.1:${publicHandle.port}/mcp`;

    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    const invalid = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${PUBLIC_TOKEN}`, "content-type": "application/json" },
      body: "{not-json",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid request body" });

    const oversized = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${PUBLIC_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(1_048_576) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request body too large" });
  });
});

describe("production wiring: fleet-enabled hub — same process, separate listeners", () => {
  it("the private fleet listener is a SEPARATE server; a WS upgrade to the PUBLIC port never reaches it", async () => {
    const fleetRuntime = createFleetRuntime({ defaultDeviceId: buildDefaultDeviceIdFromEnv({}) });
    const privateHandle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime: fleetRuntime });
    cleanups.push(privateHandle);

    // The public http-mcp server never attaches an 'upgrade' handler, so a
    // WebSocket handshake against it must fail (never silently treated as a
    // fleet registration attempt against the wrong listener) — even when
    // presented with the exact valid fleet token.
    const publicHandle = await startServer({ token: PUBLIC_TOKEN, port: 0, host: "127.0.0.1", fleet: fleetRuntime });
    cleanups.push(publicHandle);

    const wsAgainstPublic = new WebSocket(`ws://127.0.0.1:${publicHandle.port}`, {
      headers: { authorization: `Bearer ${FLEET_TOKEN}` },
    });
    wsAgainstPublic.on("error", () => {}); // expected — avoid an unhandled-error crash
    await Promise.race([new Promise((r) => wsAgainstPublic.once("error", r)), new Promise((r) => wsAgainstPublic.once("close", r))]);

    // Meanwhile the SAME token against the PRIVATE listener succeeds normally.
    const wsAgainstPrivate = new WebSocket(`ws://127.0.0.1:${privateHandle.port}`, {
      headers: { authorization: `Bearer ${FLEET_TOKEN}` },
    });
    await new Promise((resolve) => wsAgainstPrivate.once("open", resolve));
    wsAgainstPrivate.close();
  });

  it("private listener close() rejects all pending broker requests and closes connected sockets (drain on shutdown)", async () => {
    const fleetRuntime = createFleetRuntime();
    const privateHandle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime: fleetRuntime });

    const ws = new WebSocket(`ws://127.0.0.1:${privateHandle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await new Promise((resolve) => ws.once("open", resolve));
    const { encodeRegisterFrame, generateNonce } = await import("../../bridge/fleet-protocol.ts");
    ws.send(encodeRegisterFrame("device-a", "studio", ["claude"], generateNonce()));
    await new Promise((resolve) => ws.once("message", resolve)); // register_ack

    const pending = fleetRuntime.broker.sendRequest("device-a", "read", { sessionId: "x" });
    const pendingAssertion = expect(pending).rejects.toThrow();
    const closed = new Promise((resolve) => ws.once("close", resolve));

    await privateHandle.close();

    await pendingAssertion;
    await closed;
  });
});

describe("buildDefaultDeviceIdFromEnv", () => {
  it("reads TANDEM_DEFAULT_DEVICE, trims it, and treats blank as unset", () => {
    expect(buildDefaultDeviceIdFromEnv({ TANDEM_DEFAULT_DEVICE: "  device-a  " })).toBe("device-a");
    expect(buildDefaultDeviceIdFromEnv({})).toBeUndefined();
    expect(buildDefaultDeviceIdFromEnv({ TANDEM_DEFAULT_DEVICE: "   " })).toBeUndefined();
  });
});
