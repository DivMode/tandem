import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createFleetRuntime } from "../../bridge/fleet-runtime.ts";
import { assertLoopbackHost, startPrivateFleetServer, type PrivateServerHandle } from "../../bridge/fleet-private-server.ts";
import { encodeRegisterFrame, generateNonce, parseFrame } from "../../bridge/fleet-protocol.ts";
import { FleetEnrollmentStore } from "../../bridge/fleet-enrollment.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLEET_TOKEN = "test-fleet-token-01234567890123456789";

let handle: PrivateServerHandle | undefined;
const enrollmentDirectories: string[] = [];

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const directory of enrollmentDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function waitFor(ws: WebSocket, event: string): Promise<unknown[]> {
  return new Promise((resolve) => ws.once(event, (...args: unknown[]) => resolve(args)));
}

function nextFrame(ws: WebSocket): Promise<ReturnType<typeof parseFrame>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(parseFrame(data as Buffer)));
  });
}

describe("fleet-private-server: bind host (binding — correction 5)", () => {
  it("hard-refuses a non-loopback bind host synchronously, before opening any socket", () => {
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow();
    expect(() => assertLoopbackHost("192.168.1.5")).toThrow();
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
    expect(() => assertLoopbackHost("localhost")).not.toThrow();
  });

  it("startPrivateFleetServer rejects a non-loopback host and never listens", async () => {
    const runtime = createFleetRuntime();
    await expect(
      startPrivateFleetServer({ host: "0.0.0.0", port: 0, fleetToken: FLEET_TOKEN, runtime }),
    ).rejects.toThrow();
  });

  it("rejects a short fleet token before listening", async () => {
    const runtime = createFleetRuntime();
    await expect(startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: "too-short", runtime })).rejects.toThrow(
      /at least 16/,
    );
  });

  it("rejects an invalid fleet port before listening", async () => {
    const runtime = createFleetRuntime();
    await expect(
      startPrivateFleetServer({ host: "127.0.0.1", port: 70_000, fleetToken: FLEET_TOKEN, runtime }),
    ).rejects.toThrow(/port/);
  });
});

describe("fleet-private-server: auth (binding — correction 5)", () => {
  it("rejects a WebSocket upgrade with no/invalid Authorization header (401, connection closed)", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: "Bearer wrong-token" } });
    ws.on("error", () => {}); // the client always also emits 'error' here; avoid an unhandled-error crash
    await Promise.race([waitFor(ws, "error"), waitFor(ws, "close")]);
  });

  it("accepts a WebSocket upgrade with the exact bearer token", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(ws, "open");
    ws.close();
  });
});

describe("fleet-private-server: tailnet-only enrollment", () => {
  it("exchanges an expiring invitation once and never accepts its replay", async () => {
    const runtime = createFleetRuntime();
    const directory = mkdtempSync(join(tmpdir(), "tandem-private-enrollment-"));
    enrollmentDirectories.push(directory);
    const store = await FleetEnrollmentStore.open(directory);
    const invitation = await store.create();
    handle = await startPrivateFleetServer({
      host: "127.0.0.1",
      port: 0,
      fleetToken: FLEET_TOKEN,
      runtime,
      enrollment: { store, fleetToken: FLEET_TOKEN },
    });

    const first = await fetch(`http://127.0.0.1:${handle.port}/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${invitation.token}` },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ fleetToken: FLEET_TOKEN });

    const replay = await fetch(`http://127.0.0.1:${handle.port}/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${invitation.token}` },
    });
    expect(replay.status).toBe(401);
    expect(await replay.text()).not.toContain(FLEET_TOKEN);
  });

  it("keeps enrollment off by default and rejects request bodies", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    expect((await fetch(`http://127.0.0.1:${handle.port}/enroll`, { method: "POST" })).status).toBe(404);
    expect(await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json()).toEqual({ ok: true, localDevice: true });
    await handle.close();

    const directory = mkdtempSync(join(tmpdir(), "tandem-private-enrollment-"));
    enrollmentDirectories.push(directory);
    const store = await FleetEnrollmentStore.open(directory);
    const invitation = await store.create();
    handle = await startPrivateFleetServer({
      host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime,
      enrollment: { store, fleetToken: FLEET_TOKEN },
    });
    const withBody = await fetch(`http://127.0.0.1:${handle.port}/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${invitation.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(withBody.status).toBe(400);
    expect(await store.consume(invitation.token)).toBe(true);
  });
});

describe("fleet-private-server: registration + frame bounds", () => {
  it("rejects the reserved remote device id 'local' without polluting the registry", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(ws, "open");
    const closed = waitFor(ws, "close");
    ws.send(encodeRegisterFrame("local", "impostor", ["claude"], generateNonce()));
    expect(await nextFrame(ws)).toMatchObject({ type: "register_ack", ok: false });
    const [code] = (await closed) as [number];
    expect(code).toBe(4010);
    expect(runtime.registry.get("local")).toBeUndefined();
    expect(runtime.registry.publicList()).toEqual([]);
  });

  it("closes a connection that never registers within the (overridden, short) registration timeout", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({
      host: "127.0.0.1",
      port: 0,
      fleetToken: FLEET_TOKEN,
      runtime,
      registrationTimeoutMs: 50,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(ws, "open");
    const [code] = (await waitFor(ws, "close")) as [number];
    expect(code).toBe(4001);
  });

  it("registers a device and reflects it in the registry's public list", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(ws, "open");
    ws.send(encodeRegisterFrame("device-a", "studio", ["claude"], generateNonce()));
    const ack = await nextFrame(ws);
    expect(ack).toMatchObject({ type: "register_ack", ok: true });
    expect(runtime.registry.publicList()).toEqual([{ id: "device-a", name: "studio", online: true, engines: ["claude"] }]);
    ws.close();
  });

  it("closes the connection on a malformed frame", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(ws, "open");
    ws.send("{not valid json");
    const [code] = (await waitFor(ws, "close")) as [number];
    expect(code).toBe(4002);
  });

  it("closes the connection on a frame larger than the wire cap", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(ws, "open");
    ws.send("x".repeat(1_048_577));
    const [code] = (await waitFor(ws, "close")) as [number];
    expect([1009, 4002]).toContain(code);
  });

  it("closes the connection when the first frame is not a register frame", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(ws, "open");
    ws.send(JSON.stringify({ v: 1, type: "pong" }));
    const [code] = (await waitFor(ws, "close")) as [number];
    expect(code).toBe(4005);
  });
});

describe("fleet-private-server: generation-safe duplicate replacement (binding — correction 6)", () => {
  it("a newer registration rejects the old socket's pending requests, then closes it, without the old close handler unregistering the new connection", async () => {
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({ host: "127.0.0.1", port: 0, fleetToken: FLEET_TOKEN, runtime });

    const wsOld = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(wsOld, "open");
    wsOld.send(encodeRegisterFrame("device-a", "studio", ["claude"], generateNonce()));
    await nextFrame(wsOld); // register_ack

    // Issue a pending RPC against the OLD connection before it gets replaced.
    const pending = runtime.broker.sendRequest("device-a", "read", { sessionId: "x" });
    const pendingAssertion = expect(pending).rejects.toThrow();

    const wsOldClosed = waitFor(wsOld, "close");

    const wsNew = new WebSocket(`ws://127.0.0.1:${handle.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
    await waitFor(wsNew, "open");
    wsNew.send(encodeRegisterFrame("device-a", "studio-2", ["claude", "shell"], generateNonce()));
    await nextFrame(wsNew); // register_ack

    // The OLD connection's pending RPC must be rejected (deterministically, before close).
    await pendingAssertion;

    // The OLD socket gets closed by the hub as part of replacement.
    await wsOldClosed;

    // Give the old socket's 'close' handler a tick to run (generation-guarded).
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The registry must still reflect the NEW connection, not be empty.
    expect(runtime.registry.isOnline("device-a")).toBe(true);
    expect(runtime.registry.get("device-a")?.name).toBe("studio-2");
    expect(runtime.registry.publicList()).toEqual([
      { id: "device-a", name: "studio-2", online: true, engines: ["claude", "shell"] },
    ]);

    wsNew.close();
  });
});

describe("fleet-private-server: disconnect and reconnect", () => {
  it("retains safe offline metadata and marks the same device online after reconnect", async () => {
    const runtime = createFleetRuntime();
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });
    handle = await startPrivateFleetServer({
      host: "127.0.0.1",
      port: 0,
      fleetToken: FLEET_TOKEN,
      runtime,
      auditEvent: (fields) => {
        if (fields.event === "fleet.connection" && fields.reason === "disconnected") resolveDisconnected();
      },
    });
    const connect = async (name: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
      await waitFor(ws, "open");
      ws.send(encodeRegisterFrame("device-a", name, ["claude"], generateNonce()));
      await nextFrame(ws);
      return ws;
    };

    const first = await connect("studio");
    const firstClosed = waitFor(first, "close");
    first.close();
    await firstClosed;
    await disconnected;
    expect(runtime.registry.publicList()).toEqual([{ id: "device-a", name: "studio", online: false, engines: ["claude"] }]);

    const second = await connect("studio-renamed");
    expect(runtime.registry.publicList()).toEqual([
      { id: "device-a", name: "studio-renamed", online: true, engines: ["claude"] },
    ]);
    second.close();
  });
});

describe("fleet-private-server: metadata-only lifecycle audit", () => {
  it("emits accepted, replacement, disconnect, and shutdown metadata events", async () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = createFleetRuntime();
    handle = await startPrivateFleetServer({
      host: "127.0.0.1",
      port: 0,
      fleetToken: FLEET_TOKEN,
      runtime,
      auditEvent: (event) => events.push(event),
    });
    const connect = async (name: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}`, { headers: { authorization: `Bearer ${FLEET_TOKEN}` } });
      await waitFor(ws, "open");
      ws.send(encodeRegisterFrame("device-a", name, ["claude"], generateNonce()));
      await nextFrame(ws);
      return ws;
    };
    const old = await connect("studio");
    const oldClosed = waitFor(old, "close");
    const current = await connect("studio-new");
    await oldClosed;
    const currentClosed = waitFor(current, "close");
    current.close();
    await currentClosed;
    await handle.close();
    handle = undefined;

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "fleet.registration", deviceId: "device-a", outcome: "accepted" }),
        expect.objectContaining({ event: "fleet.registration", deviceId: "device-a", outcome: "replaced" }),
        expect.objectContaining({ event: "fleet.connection", deviceId: "device-a", outcome: "closed" }),
        expect.objectContaining({ event: "fleet.listener", outcome: "closed", reason: "shutdown" }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(FLEET_TOKEN);
  });
});
