import { afterEach, describe, expect, it, vi } from "vitest";

// bridge/router.ts's audit() writes to the real ~/.tandem/bridge.log as a side
// effect independent of anything under test here — stub it out exactly like
// test/router-engines.test.ts does, so this file never touches real home state.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

const { handleDeviceRequest } = await import("../../bridge/fleet-device-router.ts");
const { createFleetScheduler } = await import("../../bridge/fleet-scheduler.ts");
const { registerLive, unregisterLive } = await import("../../bridge/sessions.ts");
type DrivableSession = import("../../bridge/drivable.ts").DrivableSession;

function fakeSession(id: string): DrivableSession {
  return {
    id,
    engine: "claude",
    cwd: "/tmp/fake",
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => ({ status: "done", report: "ok", cursor: 1 }),
    read: async () => ({ text: "", cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => "fake-attach-hint",
  };
}

const opened: string[] = [];
afterEach(() => {
  for (const name of opened.splice(0)) unregisterLive(name);
});

describe("fleet-device-router: fixed op table dispatch", () => {
  it("executes send/read/interrupt/close against the local router for a registered session", async () => {
    const name = "dev-sess-1";
    registerLive(fakeSession(name));
    opened.push(name);
    const scheduler = createFleetScheduler();

    const sendResult = await handleDeviceRequest(scheduler, "send", { sessionId: name, text: "hi" });
    expect(sendResult.status).toBe(200);

    const readResult = await handleDeviceRequest(scheduler, "read", { sessionId: name });
    expect(readResult.status).toBe(200);

    const interruptResult = await handleDeviceRequest(scheduler, "interrupt", { sessionId: name });
    expect(interruptResult.status).toBe(200);

    const closeResult = await handleDeviceRequest(scheduler, "close", { sessionId: name });
    expect(closeResult.status).toBe(200);
    opened.pop(); // close() already unregistered it
  });

  it("409s a send to a session that was never opened, via the real router path", async () => {
    const scheduler = createFleetScheduler();
    const result = await handleDeviceRequest(scheduler, "send", { sessionId: "never-opened", text: "hi" });
    expect(result.status).toBe(409);
  });
});

describe("fleet-device-router: scheduler participation (binding — correction 9)", () => {
  it("serializes open_session/send/close for the same session name through the scheduler", async () => {
    const name = "dev-sess-2";
    registerLive(fakeSession(name));
    opened.push(name);
    const scheduler = createFleetScheduler();
    const scheduleSpy = vi.spyOn(scheduler, "schedule");

    await handleDeviceRequest(scheduler, "send", { sessionId: name, text: "hi" });
    expect(scheduleSpy).toHaveBeenCalledWith(`local:${name}`, expect.any(Function));

    scheduleSpy.mockClear();
    await handleDeviceRequest(scheduler, "close", { sessionId: name });
    expect(scheduleSpy).toHaveBeenCalledWith(`local:${name}`, expect.any(Function));
    opened.pop();
  });

  it("read/interrupt bypass the scheduler entirely", async () => {
    const name = "dev-sess-3";
    registerLive(fakeSession(name));
    opened.push(name);
    const scheduler = createFleetScheduler();
    const scheduleSpy = vi.spyOn(scheduler, "schedule");

    await handleDeviceRequest(scheduler, "read", { sessionId: name });
    await handleDeviceRequest(scheduler, "interrupt", { sessionId: name });
    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});
