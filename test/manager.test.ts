import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBlocked,
  initManagerMemory,
  readMemory,
  appendDecision,
  updateState,
  regroundPreamble,
  managerDir,
  enqueueTask,
  dequeueTask,
  readQueue,
} from "../bridge/manager.ts";

describe("parseBlocked (the escalation sentinel)", () => {
  it("returns the reason when a line starts with BLOCKED:", () => {
    expect(parseBlocked("BLOCKED: worker failed 3x on the parser")).toBe(
      "worker failed 3x on the parser",
    );
  });
  it("tolerates markdown emphasis and a dash separator", () => {
    expect(parseBlocked("**BLOCKED** — need your call on the API key")).toBe(
      "need your call on the API key",
    );
  });
  it("matches case-insensitively on its own line", () => {
    expect(parseBlocked("step one done\n> blocked: need a secret\nmore")).toBe(
      "need a secret",
    );
  });
  it("returns empty string for a bare BLOCKED (still blocked, no reason)", () => {
    expect(parseBlocked("BLOCKED")).toBe("");
  });
  it("does NOT trip on the word blocked inside a sentence", () => {
    expect(parseBlocked("the path was blocked but I found another route")).toBeNull();
  });
  it("returns null when there is no sentinel (e.g. a normal DONE)", () => {
    expect(parseBlocked("all good now\nDONE")).toBeNull();
  });
});

describe("manager memory (disk-backed, resumable)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-mgr-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("init writes a mission and a running state at turn 0", () => {
    initManagerMemory(dir, { goal: "ship the parser", context: "spec: v2" });
    const mem = readMemory(dir);
    expect(mem.mission).toContain("ship the parser");
    expect(mem.mission).toContain("spec: v2");
    expect(mem.state?.status).toBe("running");
    expect(mem.state?.turn).toBe(0);
  });

  it("appendDecision accumulates an append-only log tail", () => {
    initManagerMemory(dir, { goal: "g" });
    appendDecision(dir, "turn 1: told worker to write the lexer");
    appendDecision(dir, "turn 2: reviewed lexer, looks good");
    const mem = readMemory(dir);
    expect(mem.logTail).toContain("write the lexer");
    expect(mem.logTail).toContain("reviewed lexer");
  });

  it("updateState merges a patch and persists it across reads", () => {
    initManagerMemory(dir, { goal: "g" });
    updateState(dir, { turn: 5, status: "blocked", blockedReason: "need a key" });
    const mem = readMemory(dir);
    expect(mem.state?.turn).toBe(5);
    expect(mem.state?.status).toBe("blocked");
    expect(mem.state?.blockedReason).toBe("need a key");
    // unspecified fields survive the merge
    expect(typeof mem.state?.task).toBe("string");
  });

  it("regroundPreamble re-feeds the mission and recent decisions", () => {
    initManagerMemory(dir, { goal: "ship the parser" });
    appendDecision(dir, "turn 1: lexer written");
    const preamble = regroundPreamble(dir);
    expect(preamble).toContain("ship the parser");
    expect(preamble).toContain("lexer written");
  });

  it("regroundPreamble is empty for a dir with no memory yet", () => {
    expect(regroundPreamble(dir)).toBe("");
  });
});

describe("managerDir", () => {
  it("namespaces each loop under ~/.tandem/manager/<loopId>", () => {
    const d = managerDir("abc123");
    expect(d).toMatch(/[/\\]\.tandem[/\\]manager[/\\]abc123$/);
  });
});

describe("task queue (disk-persisted, so a restart resumes pending work)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-q-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("enqueue then read returns the task", () => {
    enqueueTask(dir, "write the lexer");
    expect(readQueue(dir)).toEqual(["write the lexer"]);
  });

  it("preserves FIFO order across multiple enqueues", () => {
    enqueueTask(dir, "task one");
    enqueueTask(dir, "task two");
    enqueueTask(dir, "task three");
    expect(readQueue(dir)).toEqual(["task one", "task two", "task three"]);
  });

  it("dequeue returns the FIRST task and persists the remainder", () => {
    enqueueTask(dir, "first");
    enqueueTask(dir, "second");
    expect(dequeueTask(dir)).toBe("first");
    // the remainder must survive on disk (resumable after a crash)
    expect(readQueue(dir)).toEqual(["second"]);
    expect(dequeueTask(dir)).toBe("second");
    expect(readQueue(dir)).toEqual([]);
  });

  it("dequeue on an empty/missing queue returns null (no throw)", () => {
    expect(dequeueTask(dir)).toBeNull();
    expect(readQueue(dir)).toEqual([]);
  });

  it("ignores blank tasks so an empty enqueue can't wake a parked manager", () => {
    enqueueTask(dir, "   ");
    enqueueTask(dir, "real task");
    expect(readQueue(dir)).toEqual(["real task"]);
  });

  it("reports acceptance via the return value (true accepted, false rejected)", () => {
    expect(enqueueTask(dir, "real")).toBe(true);
    expect(enqueueTask(dir, "   ")).toBe(false); // blank rejected
  });

  it("respects a max-depth cap so the queue can't grow unbounded", () => {
    expect(enqueueTask(dir, "a", 2)).toBe(true);
    expect(enqueueTask(dir, "b", 2)).toBe(true);
    expect(enqueueTask(dir, "c", 2)).toBe(false); // full -> rejected
    expect(readQueue(dir)).toEqual(["a", "b"]);
  });
});

describe("parked status round-trips (the persistent-manager idle state)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-park-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists status 'parked' so a restart knows it was idle, not finished", () => {
    initManagerMemory(dir, { goal: "g" });
    updateState(dir, { status: "parked", task: "(idle)" });
    expect(readMemory(dir).state?.status).toBe("parked");
  });
});
