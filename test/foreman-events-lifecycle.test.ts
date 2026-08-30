import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLive, unregisterLive } from "../bridge/sessions.ts";
import type { DrivableSession, EngineId, SendResult } from "../bridge/drivable.ts";
import { ForemanInbox, type ForemanEvent } from "../bridge/foreman-inbox.ts";
import { routeForTest } from "../bridge/router.ts";

/**
 * Router-level lifecycle boundaries — the regression suite for the duplicate
 * completion this branch fixes.
 *
 * NOTHING REAL IS SPAWNED. A fake DrivableSession is seeded straight into the
 * shared registry via registerLive(), which is the same registry
 * send/read/interrupt/close all resolve through. No tmux, no Herdr, no engine
 * executable, no network.
 *
 * NOTHING TOUCHES REAL HOME STATE. TANDEM_STATE_DIR is redirected to a temp
 * directory per test, and every state consumer (audit log, events.log, turn
 * ledger, foreman inbox) resolves through bridge/state-dir.ts on each write.
 */

const roots: string[] = [];
let stateDir: string;
const previousStateDir = process.env.TANDEM_STATE_DIR;
const opened: string[] = [];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tandem-lifecycle-"));
  roots.push(stateDir);
  process.env.TANDEM_STATE_DIR = stateDir;
});

afterEach(() => {
  for (const name of opened.splice(0)) unregisterLive(name);
  if (previousStateDir === undefined) delete process.env.TANDEM_STATE_DIR;
  else process.env.TANDEM_STATE_DIR = previousStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FakeOptions {
  sendStatus?: SendResult["status"];
  idle?: boolean;
  text?: string;
  identity?: string;
  sendThrows?: string;
}

/** A controllable session. `state` is mutable so a test can move the fake
 *  through a real sequence (send returns running, then a poll finds it idle). */
function seedSession(name: string, state: FakeOptions): FakeOptions {
  const session: DrivableSession = {
    id: name,
    engine: "claude" as EngineId,
    // A temp dir, never a real project: the handoff's git lookup falls back.
    cwd: stateDir,
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => {
      if (state.sendThrows) throw new Error(state.sendThrows);
      return { status: state.sendStatus ?? "done", report: state.text ?? "work report", cursor: 12 };
    },
    read: async () => ({ text: state.text ?? "work report", cursor: 12, idle: state.idle ?? true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => "fake-attach-hint",
    agentIdentity: async () => state.identity ?? "fake:agent-1",
  };
  registerLive(session);
  opened.push(name);
  return state;
}

function events(): ForemanEvent[] {
  return new ForemanInbox(join(stateDir, "foreman")).read({ limit: 200 }).events;
}

const send = (name: string, text: string) => routeForTest("POST", `/sessions/${name}/send`, { text });
const poll = (name: string, cursor: number) =>
  routeForTest("GET", `/sessions/${name}/read`, {}, `cursor=${cursor}`);

describe("a turn produces exactly one completion event", () => {
  it("send() that finishes emits one, and a confirming poll adds none", async () => {
    seedSession("w1", { sendStatus: "done", idle: true });

    await send("w1", "do the thing");
    expect(events().map((e) => e.kind)).toEqual(["completed"]);

    // The documented follow-up: poll the same session to confirm.
    await poll("w1", 12);
    await poll("w1", 12);
    expect(events().map((e) => e.kind)).toEqual(["completed"]);
  });

  it("two repeated reads at the SAME stale cursor produce exactly one event", async () => {
    // This is the exact reproduction of the bug: read({cursor}) returns
    // everything newer than `cursor`, so polling twice with the same stale
    // cursor returned identical text twice and manufactured two completions.
    const state = seedSession("w2", { sendStatus: "running", idle: false });

    await send("w2", "long job");
    expect(events()).toHaveLength(0); // still running — nothing finished yet

    state.idle = true;
    await poll("w2", 0); // stale cursor 0
    await poll("w2", 0); // same stale cursor again
    await poll("w2", 0);

    const recorded = events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("completed");
  });

  it("a long turn completed after polling is reported once, with its turn coordinates", async () => {
    const state = seedSession("w3", { sendStatus: "running", idle: false });
    await send("w3", "long job");
    state.idle = true;
    await poll("w3", 0);

    const [event] = events();
    expect(event).toMatchObject({ kind: "completed", session: "local:w3", engine: "claude", epoch: 1, turn: 1 });
    expect(event!.needs_foreman_review).toBe(true);
  });

  it("a second instruction is a second turn, and reports its own completion", async () => {
    seedSession("w4", { sendStatus: "done", idle: true });
    await send("w4", "first");
    await send("w4", "second");
    const recorded = events();
    expect(recorded.map((e) => e.turn)).toEqual([1, 2]);
    expect(new Set(recorded.map((e) => e.id)).size).toBe(2);
  });

  it("an idle session Tandem never drove reports nothing", async () => {
    seedSession("w5", { idle: true });
    await poll("w5", 0);
    await poll("w5", 0);
    expect(events()).toEqual([]);
  });
});

describe("restart and re-adoption", () => {
  it("a turn left in flight completes once across a bridge restart", async () => {
    const state = seedSession("w6", { sendStatus: "running", idle: false });
    await send("w6", "long job");

    // The turn's pending state is on disk, not in this process: a restarted
    // bridge re-adopting this session sees the same outstanding turn.
    state.idle = true;
    await poll("w6", 0);
    await poll("w6", 0);
    expect(events().map((e) => e.kind)).toEqual(["completed"]);
  });

  it("a session reopened under the same name does not complete the old agent's turn", async () => {
    const state = seedSession("w7", { sendStatus: "running", idle: false, identity: "fake:agent-1" });
    await send("w7", "long job");

    // Closed and reopened: same name, different agent.
    state.identity = "fake:agent-2";
    state.idle = true;
    await poll("w7", 0);
    expect(events()).toEqual([]);

    // And a genuine turn on the NEW incarnation reports under a new epoch.
    state.sendStatus = "done";
    await send("w7", "new work");
    const [event] = events();
    expect(event).toMatchObject({ kind: "completed", epoch: 2 });
  });
});

describe("non-completion lifecycle transitions", () => {
  it("interrupt reports `interrupted` once and cancels the pending turn", async () => {
    const state = seedSession("w8", { sendStatus: "running", idle: false });
    await send("w8", "runaway");

    await routeForTest("POST", "/sessions/w8/interrupt", {});
    expect(events().map((e) => e.kind)).toEqual(["interrupted"]);

    // The cut-short turn must never later surface as a completion.
    state.idle = true;
    await poll("w8", 0);
    expect(events().map((e) => e.kind)).toEqual(["interrupted"]);

    // A second interrupt with no turn in flight adds nothing.
    await routeForTest("POST", "/sessions/w8/interrupt", {});
    expect(events().map((e) => e.kind)).toEqual(["interrupted"]);
  });

  it("close reports `closed`, and it does not ask for review", async () => {
    seedSession("w9", { idle: true });
    await routeForTest("POST", "/sessions/w9/close", {});
    const [event] = events();
    expect(event).toMatchObject({ kind: "closed", session: "local:w9" });
    expect(event!.needs_foreman_review).toBe(false);
  });

  it("a send that fails reports `error` with a bounded reason", async () => {
    seedSession("w10", { sendThrows: "engine went away" });
    const result = await routeForTest("POST", "/sessions/w10/send", { text: "go" });
    expect(result.status).toBe(500);

    const [event] = events();
    expect(event).toMatchObject({ kind: "error" });
    expect(event!.reason).toContain("engine went away");
    expect(event!.needs_foreman_review).toBe(true);
  });
});

describe("a second instruction while a turn is still running", () => {
  it("reports the superseded turn, then the new turn's completion, with no duplicates", async () => {
    const state = seedSession("w14", { sendStatus: "running", idle: false });
    await send("w14", "first job");
    expect(events()).toEqual([]); // turn 1 still in flight

    // A second send lands in the same session. Turn 1 can never complete now.
    await send("w14", "second job");
    expect(events().map((e) => e.kind)).toEqual(["interrupted"]);
    expect(events()[0]).toMatchObject({ turn: 1, kind: "interrupted" });
    expect(events()[0]!.reason).toMatch(/superseded/i);

    // Only the live turn completes, and only once however often it is polled.
    state.idle = true;
    await poll("w14", 0);
    await poll("w14", 0);
    await poll("w14", 0);
    const recorded = events();
    expect(recorded.map((e) => e.kind)).toEqual(["interrupted", "completed"]);
    expect(recorded.map((e) => e.turn)).toEqual([1, 2]);
    expect(new Set(recorded.map((e) => e.id)).size).toBe(2);
  });

  it("does not report a supersede when the previous turn already finished", async () => {
    seedSession("w15", { sendStatus: "done", idle: true });
    await send("w15", "first");
    await send("w15", "second");
    expect(events().map((e) => e.kind)).toEqual(["completed", "completed"]);
  });

  it("still drives the session when the event cannot be persisted", async () => {
    // Reporting must never break the thing it reports on: point the state root
    // at a path that cannot hold a directory and drive a full supersede.
    const previous = process.env.TANDEM_STATE_DIR;
    process.env.TANDEM_STATE_DIR = join(stateDir, "notes.txt", "nested");
    writeFileSync(join(stateDir, "notes.txt"), "not a directory");
    try {
      const state = seedSession("w16", { sendStatus: "running", idle: false });
      expect((await send("w16", "first")).status).toBe(200);
      expect((await send("w16", "second")).status).toBe(200);
      state.idle = true;
      const polled = await poll("w16", 0);
      expect(polled.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.TANDEM_STATE_DIR;
      else process.env.TANDEM_STATE_DIR = previous;
    }
  });
});

describe("the GET /foreman/events route", () => {
  it("is read-only: reading twice returns the same events and records nothing new", async () => {
    seedSession("w11", { sendStatus: "done", idle: true });
    await send("w11", "work");

    const first = await routeForTest("GET", "/foreman/events", {}, "");
    const second = await routeForTest("GET", "/foreman/events", {}, "");
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const page = first.body as { events: ForemanEvent[]; checkpoint: string; more: boolean; truncated: boolean };
    expect(page.events).toHaveLength(1);
    expect(page.checkpoint).toMatch(/^fe1_/);
  });

  it("returns only what is new when the caller hands back its checkpoint", async () => {
    seedSession("w12", { sendStatus: "done", idle: true });
    await send("w12", "one");
    const first = (await routeForTest("GET", "/foreman/events", {}, "")).body as { checkpoint: string };

    await send("w12", "two");
    const next = (await routeForTest(
      "GET",
      "/foreman/events",
      {},
      `since=${encodeURIComponent(first.checkpoint)}`,
    )).body as { events: ForemanEvent[] };
    expect(next.events.map((e) => e.turn)).toEqual([2]);
  });

  it("rejects a malformed checkpoint with a 400 rather than guessing", async () => {
    const result = await routeForTest("GET", "/foreman/events", {}, "since=garbage");
    expect(result.status).toBe(400);
    expect(String((result.body as { error: string }).error)).toMatch(/checkpoint/i);
  });

  it("rejects a non-positive limit", async () => {
    expect((await routeForTest("GET", "/foreman/events", {}, "limit=0")).status).toBe(400);
    expect((await routeForTest("GET", "/foreman/events", {}, "limit=-3")).status).toBe(400);
  });

  it("never returns a cwd, an attach hint, a handoff, or any absolute path", async () => {
    seedSession("w13", { sendStatus: "done", idle: true, text: `wrote ${join(stateDir, "notes.md")}` });
    await send("w13", "work");
    const body = JSON.stringify((await routeForTest("GET", "/foreman/events", {}, "")).body);
    expect(body).not.toContain(stateDir);
    expect(body).not.toContain("attachHint");
    expect(body).not.toContain("handoff");
    expect(body).not.toContain("fake-attach-hint");
  });
});
