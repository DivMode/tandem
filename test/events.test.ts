import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { emitCompletion, emitLifecycle, emitNeedsInput, eventsLogPath } from "../bridge/events.ts";
import { ForemanInbox } from "../bridge/foreman-inbox.ts";

/**
 * emitCompletion has four sinks: events.log (always), webhook (if set), ntfy
 * (if a topic is set), and the foreman inbox (always). The `silent` flag
 * suppresses ONLY the ntfy phone push, so routine per-task completions stay
 * durable without buzzing a phone; we verify that gating by spying on global
 * fetch (the ntfy POST).
 *
 * ISOLATION: these tests used to append to the developer's REAL
 * ~/.tandem/events.log on every run. Every state consumer now resolves its
 * directory through bridge/state-dir.ts on each write, so pointing
 * TANDEM_STATE_DIR at a temp directory redirects all of it — and the last test
 * here asserts that real home state is genuinely untouched.
 */

const temporaryRoots: string[] = [];
let stateDir: string;
const previousStateDir = process.env.TANDEM_STATE_DIR;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tandem-events-"));
  temporaryRoots.push(stateDir);
  process.env.TANDEM_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.TANDEM_STATE_DIR;
  else process.env.TANDEM_STATE_DIR = previousStateDir;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lastLineWithId(id: string): Record<string, unknown> {
  const lines = readFileSync(eventsLogPath(), "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = JSON.parse(lines[i]!) as Record<string, unknown>;
    if (o.id === id) return o;
  }
  throw new Error(`no events.log line with id ${id}`);
}

const turn = { epoch: 1, turn: 1, engine: "claude", device: "local" };

describe("emitCompletion silent flag — gates ONLY the ntfy phone push", () => {
  const prevTopic = process.env.TANDEM_NTFY_TOPIC;
  const prevHook = process.env.TANDEM_DONE_WEBHOOK;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.TANDEM_NTFY_TOPIC = "tandem-unit-test-topic";
    delete process.env.TANDEM_DONE_WEBHOOK; // isolate: only ntfy could fetch
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevTopic === undefined) delete process.env.TANDEM_NTFY_TOPIC;
    else process.env.TANDEM_NTFY_TOPIC = prevTopic;
    if (prevHook === undefined) delete process.env.TANDEM_DONE_WEBHOOK;
    else process.env.TANDEM_DONE_WEBHOOK = prevHook;
  });

  const ev = { type: "relay" as const, id: "loopX", cursor: 1, summary: "task done", turn };

  it("buzzes (POSTs ntfy) when silent is not set", () => {
    emitCompletion(ev);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("tandem-unit-test-topic");
  });

  it("does NOT buzz when silent:true", () => {
    emitCompletion({ ...ev, silent: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("events.log line shape (durable record for every transition)", () => {
  it("a silent completion is still logged, and the silent flag is NOT serialized", () => {
    const id = "silent-shape";
    emitCompletion({ type: "relay", id, cursor: 3, summary: "routine task done", reason: "task done", silent: true, turn });
    const line = lastLineWithId(id);
    expect(Object.hasOwn(line, "silent")).toBe(false); // flag must not leak into the record
    expect(line.status).toBe("done");
    expect(line.event).toBeUndefined(); // a plain completion, not tagged
  });

  it("a needs-input event is tagged event:'needs_input' and carries the question", () => {
    const id = "needs-shape";
    emitNeedsInput({ type: "relay", id, cursor: 4, summary: "needs your answer", reason: "which DB?", turn });
    const line = lastLineWithId(id);
    expect(line.event).toBe("needs_input");
    expect(line.reason).toBe("which DB?");
  });

  it("a lifecycle event is tagged with its own kind rather than a blanket status:'done'", () => {
    emitLifecycle({ type: "session", id: "life-shape", kind: "interrupted", reason: "interrupted by the caller", turn });
    const line = lastLineWithId("life-shape");
    expect(line.event).toBe("interrupted");
    // H: the old shape stamped status:'done' on everything, which made an
    // interrupt indistinguishable from a completion to any consumer.
    expect(line.status).toBeUndefined();
  });
});

describe("every emitter also lands in the foreman inbox (one emit path, two sinks)", () => {
  it("records completion, needs-input and lifecycle transitions with distinct kinds", () => {
    emitCompletion({ type: "session", id: "w", cursor: 10, summary: "built it", turn: { ...turn, turn: 1 } });
    emitNeedsInput({ type: "session", id: "w", cursor: 11, summary: "q", reason: "which DB?", turn: { ...turn, turn: 2 } });
    emitLifecycle({ type: "session", id: "w", kind: "closed", turn: { ...turn, turn: 3 } });

    const page = new ForemanInbox(join(stateDir, "foreman")).read();
    expect(page.events.map((e) => e.kind)).toEqual(["completed", "needs_input", "closed"]);
    expect(page.events.map((e) => e.needs_foreman_review)).toEqual([true, true, false]);
    expect(page.events.every((e) => e.session === "local:w")).toBe(true);
  });

  it("never carries the handoff block, the cwd, or any other path into the inbox", () => {
    emitCompletion({
      type: "session",
      id: "leaky",
      cursor: 1,
      summary: "wrote /Users/someone/secret-project/notes.md",
      cwd: "/Users/someone/secret-project",
      turn,
    });
    const page = new ForemanInbox(join(stateDir, "foreman")).read();
    const event = page.events.at(-1)!;
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("/Users/someone");
    expect(serialized).not.toContain("secret-project");
    expect(Object.hasOwn(event, "handoff")).toBe(false);
    expect(Object.hasOwn(event, "cwd")).toBe(false);
    // The events.log line MAY keep the local handoff block; the inbox may not.
    expect(lastLineWithId("leaky").handoff).toBeTypeOf("string");
  });
});

describe("state isolation", () => {
  it("writes nothing into the real ~/.tandem when TANDEM_STATE_DIR is set", () => {
    expect(eventsLogPath().startsWith(stateDir)).toBe(true);
    expect(eventsLogPath().startsWith(join(homedir(), ".tandem"))).toBe(false);
  });
});
