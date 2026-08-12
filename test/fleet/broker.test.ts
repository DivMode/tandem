import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFleetRegistry, type FleetSocket } from "../../bridge/fleet-registry.ts";
import {
  BackpressureError,
  DeviceOfflineError,
  InFlightLimitError,
  RpcRejectedError,
  RpcTimeoutError,
  createFleetBroker,
} from "../../bridge/fleet-broker.ts";

function fakeSocket(overrides: Partial<FleetSocket> = {}): FleetSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: (data: string) => sent.push(data),
    close: () => {},
    bufferedAmount: 0,
    ...overrides,
  };
}

describe("fleet-broker: bounds", () => {
  it("throws DeviceOfflineError for a device that never registered", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    await expect(broker.sendRequest("nope", "read", { sessionId: "x" })).rejects.toThrow(DeviceOfflineError);
  });

  it("hard-rejects the request the moment MAX_IN_FLIGHT_PER_DEVICE (32) is reached — never queues", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    // Every request stays pending (no response delivered), so in-flight count only grows.
    for (let i = 0; i < 32; i++) {
      void broker.sendRequest("device-a", "read", { sessionId: `s${i}` }).catch(() => {});
    }
    expect(broker.inFlightCount("device-a")).toBe(32);
    await expect(broker.sendRequest("device-a", "read", { sessionId: "one-too-many" })).rejects.toThrow(InFlightLimitError);
    // The rejection must be immediate — it must not have been silently queued as request #33.
    expect(broker.inFlightCount("device-a")).toBe(32);
    // Cleanup: clear the 32 still-pending timers so they don't outlive this test.
    broker.rejectAll("device-a", "test cleanup");
  });

  it("refuses a new request when the device socket is backpressured", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    registry.register("device-a", "studio", ["claude"], fakeSocket({ bufferedAmount: 100 * 1024 * 1024 }));
    await expect(broker.sendRequest("device-a", "read", { sessionId: "x" })).rejects.toThrow(BackpressureError);
  });
});

describe("fleet-broker: request/response lifecycle", () => {
  it("resolves a pending request when a matching response arrives", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    const socket = fakeSocket();
    registry.register("device-a", "studio", ["claude"], socket);
    const promise = broker.sendRequest("device-a", "read", { sessionId: "x" });
    expect(socket.sent).toHaveLength(1);
    const sentFrame = JSON.parse(socket.sent[0]!);
    broker.handleResponse("device-a", sentFrame.id, true, 200, { text: "hi" });
    await expect(promise).resolves.toEqual({ status: 200, body: { text: "hi" } });
  });

  it("rejects a pending request when the device responds ok:false", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    const socket = fakeSocket();
    registry.register("device-a", "studio", ["claude"], socket);
    const promise = broker.sendRequest("device-a", "read", { sessionId: "x" });
    const sentFrame = JSON.parse(socket.sent[0]!);
    broker.handleResponse("device-a", sentFrame.id, false, undefined, undefined, "boom");
    await expect(promise).rejects.toThrow(RpcRejectedError);
  });

  it("a response for an unknown/late request id is silently ignored, never throws", () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    expect(() => broker.handleResponse("device-a", "unknown-id", true, 200, {})).not.toThrow();
  });
});

describe("fleet-broker: timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects with RpcTimeoutError after the configured timeout and frees the in-flight slot", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const promise = broker.sendRequest("device-a", "read", { sessionId: "x" }, { timeoutMs: 1000 });
    const assertion = expect(promise).rejects.toThrow(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(broker.inFlightCount("device-a")).toBe(0);
  });
});

describe("fleet-broker: deterministic pending rejection", () => {
  it("rejectAll rejects every pending request for a device, oldest first, and clears them", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const order: number[] = [];
    const p1 = broker.sendRequest("device-a", "read", { sessionId: "a" }).catch(() => order.push(1));
    const p2 = broker.sendRequest("device-a", "read", { sessionId: "b" }).catch(() => order.push(2));
    const p3 = broker.sendRequest("device-a", "read", { sessionId: "c" }).catch(() => order.push(3));
    broker.rejectAll("device-a", "device disconnected");
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
    expect(broker.inFlightCount("device-a")).toBe(0);
  });

  it("rejectEverything drains every device's pending requests (hub shutdown)", async () => {
    const registry = createFleetRegistry();
    const broker = createFleetBroker(registry);
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    registry.register("device-b", "laptop", ["claude"], fakeSocket());
    const pa = broker.sendRequest("device-a", "read", { sessionId: "x" });
    const pb = broker.sendRequest("device-b", "read", { sessionId: "y" });
    const aAssertion = expect(pa).rejects.toThrow(RpcRejectedError);
    const bAssertion = expect(pb).rejects.toThrow(RpcRejectedError);
    broker.rejectEverything("server shutting down");
    await aAssertion;
    await bAssertion;
  });
});
