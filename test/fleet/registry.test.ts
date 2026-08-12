import { describe, expect, it } from "vitest";
import { createFleetRegistry, type FleetSocket } from "../../bridge/fleet-registry.ts";

function fakeSocket(): FleetSocket & { closed: boolean; closeCode?: number } {
  const socket = {
    closed: false,
    closeCode: undefined as number | undefined,
    send: () => {},
    close(code?: number) {
      socket.closed = true;
      socket.closeCode = code;
    },
    bufferedAmount: 0,
  };
  return socket;
}

describe("fleet-registry", () => {
  it("registers a device and lists it with the exact public shape", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude", "codex"], fakeSocket());
    expect(registry.publicList()).toEqual([{ id: "device-a", name: "studio", online: true, engines: ["claude", "codex"] }]);
  });

  it("publicList never includes any field beyond id/name/online/engines", () => {
    const registry = createFleetRegistry();
    registry.register("device-a", "studio", ["claude"], fakeSocket());
    const [entry] = registry.publicList();
    expect(Object.keys(entry!).sort()).toEqual(["engines", "id", "name", "online"]);
  });

  it("unregister only succeeds for the CURRENT generation", () => {
    const registry = createFleetRegistry();
    const { generation } = registry.register("device-a", "studio", ["claude"], fakeSocket());
    // A stale generation (e.g. from an already-superseded connection) must not remove the live entry.
    expect(registry.unregister("device-a", generation - 1)).toBe(false);
    expect(registry.isOnline("device-a")).toBe(true);
    expect(registry.unregister("device-a", generation)).toBe(true);
    expect(registry.isOnline("device-a")).toBe(false);
    expect(registry.publicList()).toEqual([{ id: "device-a", name: "studio", online: false, engines: ["claude"] }]);
  });

  it("a duplicate registration bumps the generation and returns the replaced connection", () => {
    const registry = createFleetRegistry();
    const first = fakeSocket();
    const { generation: gen1 } = registry.register("device-a", "studio", ["claude"], first);
    const { generation: gen2, replaced } = registry.register("device-a", "studio-renamed", ["claude", "shell"], fakeSocket());
    expect(gen2).toBeGreaterThan(gen1);
    expect(replaced?.socket).toBe(first);
    expect(registry.get("device-a")?.generation).toBe(gen2);
    // The OLD generation must no longer be able to unregister the NEW connection.
    expect(registry.unregister("device-a", gen1)).toBe(false);
    expect(registry.isOnline("device-a")).toBe(true);
  });

  it("updateEngines is generation-guarded like unregister", () => {
    const registry = createFleetRegistry();
    const { generation } = registry.register("device-a", "studio", ["claude"], fakeSocket());
    expect(registry.updateEngines("device-a", generation - 1, ["claude", "codex"])).toBe(false);
    expect(registry.get("device-a")?.engines).toEqual(["claude"]);
    expect(registry.updateEngines("device-a", generation, ["claude", "codex"])).toBe(true);
    expect(registry.get("device-a")?.engines).toEqual(["claude", "codex"]);
    expect(registry.publicList()[0]?.engines).toEqual(["claude", "codex"]);
  });

  it("an unknown device id is simply offline, never throws", () => {
    const registry = createFleetRegistry();
    expect(registry.isOnline("nope")).toBe(false);
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.unregister("nope", 1)).toBe(false);
  });
});
