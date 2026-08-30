import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hub-side routing for the foreman event feed.
 *
 * FAKE SOCKETS ONLY. Every "device" here is a registry entry backed by a socket
 * double plus a scripted broker; nothing opens a connection, spawns a session,
 * or reaches a real machine. The local half writes into an injected temp state
 * directory.
 */

const {
  dispatchForemanEvents,
} = await import("../../bridge/fleet-dispatch.ts");
const { createFleetRegistry } = await import("../../bridge/fleet-registry.ts");
const { createFleetScheduler } = await import("../../bridge/fleet-scheduler.ts");
const { ForemanInbox } = await import("../../bridge/foreman-inbox.ts");
const { decodeForemanCheckpoint, encodeForemanCheckpoint } = await import(
  "../../bridge/foreman-checkpoint.ts"
);
const { DeviceOfflineError, RpcTimeoutError } = await import("../../bridge/fleet-broker.ts");

type FleetRuntime = import("../../bridge/fleet-runtime.ts").FleetRuntime;
type FleetBroker = import("../../bridge/fleet-broker.ts").FleetBroker;
type FleetSocket = import("../../bridge/fleet-registry.ts").FleetSocket;
type ForemanEvent = import("../../bridge/foreman-inbox.ts").ForemanEvent;

function fakeSocket(): FleetSocket {
  return { send: () => {}, close: () => {}, bufferedAmount: 0 };
}

interface BrokerCall {
  deviceId: string;
  op: string;
  payload: unknown;
}

const calls: BrokerCall[] = [];

function scriptedBroker(
  handler: (deviceId: string, op: string, payload: unknown) => Promise<{ status: number; body: unknown }>,
): FleetBroker {
  return {
    sendRequest: (deviceId: string, op: string, payload: unknown) => {
      calls.push({ deviceId, op, payload });
      return handler(deviceId, op, payload);
    },
    handleResponse: () => {},
    rejectAll: () => {},
    rejectEverything: () => {},
    inFlightCount: () => 0,
  } as unknown as FleetBroker;
}

function runtimeWith(
  handler: (deviceId: string, op: string, payload: unknown) => Promise<{ status: number; body: unknown }>,
  online: string[] = ["studio"],
): FleetRuntime {
  const registry = createFleetRegistry();
  for (const id of online) registry.register(id, id, ["claude"], fakeSocket());
  return { registry, broker: scriptedBroker(handler), scheduler: createFleetScheduler() } as FleetRuntime;
}

/** A page shaped exactly like a remote device's own inbox read. */
function remotePage(events: Partial<ForemanEvent>[], checkpoint: string, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      version: 1,
      events: events.map((e, i) => ({
        v: 1,
        id: `fe_remote${i}`,
        seq: i + 1,
        ts: new Date().toISOString(),
        kind: "completed",
        source: "session",
        device: "self-reported",
        localName: "review",
        session: "self-reported:review",
        epoch: 1,
        turn: i + 1,
        needs_foreman_review: true,
        ...e,
      })),
      checkpoint,
      more: false,
      truncated: false,
      counts: { returned: events.length, retained: events.length },
      ...extra,
    },
  };
}

const roots: string[] = [];
let stateDir: string;
beforeEach(() => {
  calls.length = 0;
  stateDir = mkdtempSync(join(tmpdir(), "tandem-fleet-foreman-"));
  roots.push(stateDir);
  process.env.TANDEM_STATE_DIR = stateDir;
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function body(result: { body: unknown }) {
  return result.body as {
    events: ForemanEvent[];
    checkpoint: string;
    device: string;
    error?: string;
    more: boolean;
    truncated: boolean;
  };
}

describe("local behaviour is unchanged", () => {
  it("omitting device reads this hub's own inbox", async () => {
    new ForemanInbox(join(stateDir, "foreman")).record({
      kind: "completed",
      source: "session",
      localName: "w1",
      epoch: 1,
      turn: 1,
      summary: "local work",
    });
    const runtime = runtimeWith(async () => {
      throw new Error("must not reach the broker for a local read");
    });
    const page = body(await dispatchForemanEvents(runtime, {}));
    expect(page.events.map((e) => e.session)).toEqual(["local:w1"]);
    expect(page.device).toBe("local");
    expect(calls).toEqual([]); // nothing left this host
  });

  it('device:"local" is the same local read', async () => {
    const runtime = runtimeWith(async () => {
      throw new Error("must not reach the broker");
    });
    const page = body(await dispatchForemanEvents(runtime, { device: "local" }));
    expect(page.device).toBe("local");
    expect(calls).toEqual([]);
  });

  it("reading the local inbox never consults the fleet registry or broker", async () => {
    // A runtime whose registry and broker both explode: a local read must not
    // touch either, which is what stops a device from recursing into the fleet
    // while answering an incoming foreman_events request.
    const exploding = {
      registry: {
        isOnline: () => {
          throw new Error("registry must not be consulted for a local read");
        },
      },
      broker: {
        sendRequest: () => {
          throw new Error("broker must not be consulted for a local read");
        },
      },
      scheduler: createFleetScheduler(),
    } as unknown as FleetRuntime;
    await expect(dispatchForemanEvents(exploding, {})).resolves.toMatchObject({ status: 200 });
  });
});

describe("routing to a device", () => {
  it("executes the read on that device and returns its events", async () => {
    const runtime = runtimeWith(async () => remotePage([{ localName: "build" }], "fe1_cmVtb3Rl"));
    const page = body(await dispatchForemanEvents(runtime, { device: "studio" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ deviceId: "studio", op: "foreman_events" });
    expect(page.events).toHaveLength(1);
    expect(page.device).toBe("studio");
  });

  it("overwrites a device's self-reported id with the hub's routing identity", async () => {
    // The device claims to be "impostor". The hub routed to "studio", so that
    // is what the caller must be told — a composite name that does not route
    // back to the same worker would be worse than useless.
    const runtime = runtimeWith(async () =>
      remotePage([{ device: "impostor", session: "impostor:build", localName: "build" }], "fe1_cmVtb3Rl"),
    );
    const page = body(await dispatchForemanEvents(runtime, { device: "studio" }));
    expect(page.events[0]!.device).toBe("studio");
    expect(page.events[0]!.session).toBe("studio:build");
    expect(JSON.stringify(page)).not.toContain("impostor");
  });

  it("passes only the target device's own cursor to that device", async () => {
    const token = encodeForemanCheckpoint(
      new Map([
        ["local", "fe1_bG9jYWw"],
        ["studio", "fe1_c3R1ZGlv"],
      ]),
    );
    const runtime = runtimeWith(async () => remotePage([], "fe1_bmV3"));
    await dispatchForemanEvents(runtime, { device: "studio", since: token });
    expect(calls[0]!.payload).toEqual({ since: "fe1_c3R1ZGlv", limit: undefined });
  });
});

describe("checkpoint map", () => {
  it("advances only the device read, preserving every other entry verbatim", async () => {
    const token = encodeForemanCheckpoint(
      new Map([
        ["local", "fe1_bG9jYWw"],
        ["laptop", "fe1_bGFwdG9w"],
        ["studio", "fe1_b2xk"],
      ]),
    );
    const runtime = runtimeWith(async () => remotePage([], "fe1_ZnJlc2g"));
    const page = body(await dispatchForemanEvents(runtime, { device: "studio", since: token }));

    const map = decodeForemanCheckpoint(page.checkpoint);
    expect(map.get("studio")).toBe("fe1_ZnJlc2g"); // advanced
    expect(map.get("local")).toBe("fe1_bG9jYWw"); // untouched
    expect(map.get("laptop")).toBe("fe1_bGFwdG9w"); // untouched
  });

  it("accepts a legacy fe1 token as the local device's position", async () => {
    const map = decodeForemanCheckpoint("fe1_c29tZXRoaW5n");
    expect(map.get("local")).toBe("fe1_c29tZXRoaW5n");
    expect(map.size).toBe(1);
  });

  it("re-issues a legacy token as fe2 without losing the local position", async () => {
    const runtime = runtimeWith(async () => {
      throw new Error("local read must not reach the broker");
    });
    const page = body(await dispatchForemanEvents(runtime, { since: "fe1_" + Buffer.from("0.0").toString("base64url") }));
    expect(page.checkpoint.startsWith("fe2_")).toBe(true);
    expect(decodeForemanCheckpoint(page.checkpoint).has("local")).toBe(true);
  });

  it("is stable for an unchanged position, so a client can see nothing moved", () => {
    const map = new Map([
      ["studio", "fe1_a"],
      ["local", "fe1_b"],
    ]);
    const reordered = new Map([
      ["local", "fe1_b"],
      ["studio", "fe1_a"],
    ]);
    expect(encodeForemanCheckpoint(map)).toBe(encodeForemanCheckpoint(reordered));
  });

  it("rejects a malformed token with a 400 rather than guessing a position", async () => {
    const runtime = runtimeWith(async () => remotePage([], "fe1_x"));
    const result = await dispatchForemanEvents(runtime, { since: "garbage" });
    expect(result.status).toBe(400);
    expect(String(body(result).error)).toMatch(/checkpoint/i);
  });

  it("carries no path, host, or credential material", () => {
    const token = encodeForemanCheckpoint(new Map([["studio", "fe1_abc"]]));
    const decoded = Buffer.from(token.slice("fe2_".length), "base64url").toString("utf8");
    expect(decoded).toBe('{"v":2,"d":{"studio":"fe1_abc"}}');
  });
});

describe("failures are explicit and sanitized", () => {
  it("names an offline device rather than returning an empty page", async () => {
    const runtime = runtimeWith(async () => remotePage([], "fe1_x"), []);
    const result = await dispatchForemanEvents(runtime, { device: "studio" });
    expect(result.status).toBe(404);
    expect(body(result).error).toBe('device "studio" is not online');
    expect(body(result).device).toBe("studio");
  });

  it("reduces a transport failure to a coarse message with no host or path detail", async () => {
    const runtime = runtimeWith(async () => {
      throw new RpcTimeoutError("no response from 100.64.0.7 (/Users/someone/.tandem/sock) after 30000ms");
    });
    const result = await dispatchForemanEvents(runtime, { device: "studio" });
    expect(result.status).toBe(504);
    const message = String(body(result).error);
    expect(message).toBe('device "studio" did not answer in time');
    expect(message).not.toMatch(/100\.64|\/Users|sock/);
  });

  it("sanitizes an offline-error thrown from the broker too", async () => {
    const runtime = runtimeWith(async () => {
      throw new DeviceOfflineError("studio at fd7a:115c:a1e0::1 went away");
    });
    const result = await dispatchForemanEvents(runtime, { device: "studio" });
    expect(String(body(result).error)).toBe('device "studio" is not online');
    expect(JSON.stringify(result.body)).not.toContain("fd7a");
  });
});
