import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitNextTask } from "../bridge/relay.ts";
import { enqueueTask } from "../bridge/manager.ts";

// awaitNextTask is the park-and-wait wake protocol (Phase 6b). It depends only on
// loop.{memDir,logPath,running,parked,wake,idleTimer,idleTimeoutMs} — never on the
// tmux sessions — so we drive it directly with a fake loop. enqueue/stop are
// simulated exactly as the real functions do: enqueueTask(dir,...) then
// loop.wake('task'); for stop, loop.running=false then loop.wake('stop').

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for condition");
    await sleep(5);
  }
}

function fakeLoop(dir: string, overrides: Record<string, unknown> = {}): any {
  return {
    loopId: "test",
    leadName: "l",
    workerName: "w",
    memDir: dir,
    logPath: join(dir, "transcript.log"),
    running: true,
    parked: false,
    idleTimeoutMs: 5000,
    maxTurns: 5,
    perTaskWallClockMs: 1000,
    deadline: Date.now() + 1000,
    ...overrides,
  };
}

describe("awaitNextTask — the park-and-wait wake protocol", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-park-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fast path: returns an already-queued task immediately without parking", async () => {
    enqueueTask(dir, "already here");
    const loop = fakeLoop(dir);
    const got = await awaitNextTask(loop);
    expect(got).toBe("already here");
    expect(loop.parked).toBe(false); // never had to park
  });

  it("parks when idle, then an enqueue wakes it with the new task", async () => {
    const loop = fakeLoop(dir);
    const p = awaitNextTask(loop);
    await waitUntil(() => loop.parked === true); // it actually parked
    // Simulate enqueue(): persist FIRST, then wake.
    enqueueTask(dir, "do the thing");
    loop.wake("task");
    expect(await p).toBe("do the thing");
    expect(loop.parked).toBe(false); // disarmed on wake
    expect(loop.idleTimer).toBeUndefined(); // idle timer cleared
  });

  it("a stop while parked returns null promptly (terminate)", async () => {
    const loop = fakeLoop(dir);
    const p = awaitNextTask(loop);
    await waitUntil(() => loop.parked === true);
    // Simulate stop(): flip running, then wake.
    loop.running = false;
    loop.wake("stop");
    expect(await p).toBeNull();
  });

  it("returns null after the idle-timeout when no task ever arrives", async () => {
    const loop = fakeLoop(dir, { idleTimeoutMs: 40 });
    const t0 = Date.now();
    const got = await awaitNextTask(loop);
    expect(got).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35); // it actually waited
  });

  it("does not lose a task that races in just as the idle-timeout fires", async () => {
    // Drain-after-wake: even if 'idle' wins the race, a task persisted to disk is
    // still picked up rather than dropped.
    const loop = fakeLoop(dir, { idleTimeoutMs: 30 });
    const p = awaitNextTask(loop);
    await waitUntil(() => loop.parked === true);
    enqueueTask(dir, "raced in"); // persisted, but DON'T call wake (simulate the gap)
    // idle timer will fire ~30ms; awaitNextTask must still drain the queued task.
    expect(await p).toBe("raced in");
  });

  it("never returns a task once stopped, even if one is queued", async () => {
    enqueueTask(dir, "should-not-run");
    const loop = fakeLoop(dir, { running: false });
    expect(await awaitNextTask(loop)).toBeNull();
  });
});
