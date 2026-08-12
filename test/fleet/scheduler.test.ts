import { describe, expect, it } from "vitest";
import { createFleetScheduler } from "../../bridge/fleet-scheduler.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("fleet-scheduler", () => {
  it("serializes same-key operations — two shell sends can never interleave", async () => {
    const scheduler = createFleetScheduler();
    const events: string[] = [];
    const gate = deferred<void>();

    const first = scheduler.schedule("device-a:sess", async () => {
      events.push("first-start");
      await gate.promise;
      events.push("first-end");
    });
    const second = scheduler.schedule("device-a:sess", async () => {
      events.push("second-start");
    });

    // "second" must NOT have started while "first" is still awaiting its gate.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("different keys run independently, without waiting on each other", async () => {
    const scheduler = createFleetScheduler();
    const gate = deferred<void>();
    const events: string[] = [];

    const blocked = scheduler.schedule("device-a:sess-1", async () => {
      await gate.promise;
      events.push("blocked-done");
    });
    const unblocked = scheduler.schedule("device-a:sess-2", async () => {
      events.push("unblocked-done");
    });

    await unblocked;
    expect(events).toEqual(["unblocked-done"]);
    gate.resolve();
    await blocked;
    expect(events).toEqual(["unblocked-done", "blocked-done"]);
  });

  it("one operation throwing does not wedge later operations on the same key", async () => {
    const scheduler = createFleetScheduler();
    const first = scheduler.schedule("k", async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");
    const second = await scheduler.schedule("k", async () => "ok");
    expect(second).toBe("ok");
  });

  it("cleans up its per-key entry once nothing is pending", async () => {
    const scheduler = createFleetScheduler();
    await scheduler.schedule("k", async () => "done");
    expect(scheduler.pendingKeyCount()).toBe(0);
  });
});
