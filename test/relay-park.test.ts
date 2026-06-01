import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitNextTask } from "../bridge/relay.ts";
import { enqueueTask, setAnswer, readQueue } from "../bridge/manager.ts";

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
    answerIdleTimeoutMs: 5000,
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

  it("uses the LONGER answer-idle cap when awaiting an answer (pendingQuestion set)", async () => {
    // Routine idle is tiny; the answer cap is what should govern the wait.
    const loop = fakeLoop(dir, { idleTimeoutMs: 20, answerIdleTimeoutMs: 80, pendingQuestion: "which DB?" });
    const t0 = Date.now();
    expect(await awaitNextTask(loop)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70); // waited the answer cap, not the 20ms routine cap
  });

  it("uses the routine idle cap when NOT awaiting an answer", async () => {
    const loop = fakeLoop(dir, { idleTimeoutMs: 30, answerIdleTimeoutMs: 5000, pendingQuestion: undefined });
    const t0 = Date.now();
    expect(await awaitNextTask(loop)).toBeNull();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(25);
    expect(waited).toBeLessThan(2000); // did NOT use the 5s answer cap
  });

  it("drains an answer that races in as the answer-idle timer fires (no dropped answer)", async () => {
    const loop = fakeLoop(dir, { idleTimeoutMs: 5000, answerIdleTimeoutMs: 30, pendingQuestion: "which DB?" });
    const p = awaitNextTask(loop);
    await waitUntil(() => loop.parked === true);
    setAnswer(dir, "use postgres"); // the answer (separate channel), persisted, wake NOT called
    expect(await p).toBe("use postgres");
  });

  it("while awaiting an answer, a PRE-QUEUED task is NOT consumed as the answer", async () => {
    // The conflation bug (review finding 1): a task queued before the question
    // must not be mistaken for the answer.
    enqueueTask(dir, "a different task queued earlier");
    const loop = fakeLoop(dir, { idleTimeoutMs: 5000, answerIdleTimeoutMs: 40, pendingQuestion: "which DB?" });
    const p = awaitNextTask(loop);
    await waitUntil(() => loop.parked === true);
    setAnswer(dir, "use postgres"); // the real answer
    expect(await p).toBe("use postgres"); // NOT "a different task queued earlier"
    // the pre-queued task is still in the queue, untouched
    expect(readQueue(dir)).toEqual(["a different task queued earlier"]);
  });
});
