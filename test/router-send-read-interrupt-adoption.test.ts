import { describe, it, expect, vi } from "vitest";
import type { TerminalSessionLike } from "../bridge/engines/terminal-adapter.ts";
import type { TerminalBackend, TerminalEngineId } from "../bridge/terminal-backend.ts";

/**
 * A session that `GET /sessions` (list_sessions) advertises as live after a
 * bridge restart must be transparently drivable by send/read/interrupt, not
 * just open_session/close.
 *
 * The registry is per-process: a session opened before a restart is not in
 * it, but sessions.ts's listSessions() already reports it as `live: true` by
 * asking the backend directly (see sessions.ts's adoptedCandidates). Before
 * this was fixed, send/read/interrupt took the registry as the whole truth
 * and answered 409 "not live; call open_session first" for exactly the
 * session list_sessions had just advertised as live — close already had the
 * re-adoption fix (see router-close-adoption.test.ts); send/read/interrupt
 * did not.
 *
 * Everything here is injected. No tmux, no Herdr, no real terminal.
 */

const interrupted: string[] = [];
const attachCalls: Array<{ name: string; engine: TerminalEngineId; allowlist: string[] }> = [];

function fakeTerminal(name: string): TerminalSessionLike {
  return {
    name,
    cwd: "/allowed/project",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "fake attach",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text) => ({ report: `echo:${text}`, cursor: 1, status: "done" as const }),
    readSince: async (cursor) => ({ text: cursor === 0 ? "fresh" : "", cursor: 1, idle: true }),
    applyControls: async () => [],
    interrupt: async () => {
      interrupted.push(name);
    },
    close: async () => {},
  };
}

const backend: TerminalBackend = {
  kind: "herdr",
  spawn: async () => {
    throw new Error("spawn must not be called by send/read/interrupt");
  },
  attachExisting: async (name, engine, allowlist) => {
    attachCalls.push({ name, engine, allowlist });
    return name === "survivor" ? fakeTerminal(name) : undefined;
  },
  exists: async (name) => name === "survivor",
  engineTagOf: async (name) => (name === "survivor" ? "claude" : undefined),
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

vi.mock("../bridge/terminal-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge/terminal-backend.ts")>();
  return { ...actual, terminalBackend: backend };
});

const { routeForTest } = await import("../bridge/router.ts");

describe("send/read/interrupt re-adopt a session that outlived the bridge", () => {
  it("send drives an owned session that is not yet in this process's registry", async () => {
    const res = await routeForTest("POST", "/sessions/survivor/send", { text: "hello" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "done", name: "survivor", engine: "claude", report: "echo:hello" });
  });

  it("send in poll mode (empty text) reads an owned session that is not yet registered", async () => {
    const res = await routeForTest("POST", "/sessions/survivor/send", { text: "" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: "fresh", idle: true, live: true, engine: "claude" });
  });

  it("GET read re-adopts an owned session that is not yet registered", async () => {
    const res = await routeForTest("GET", "/sessions/survivor/read");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: "fresh", idle: true, live: true, engine: "claude" });
  });

  it("interrupt re-adopts an owned session that is not yet registered", async () => {
    const res = await routeForTest("POST", "/sessions/survivor/interrupt");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "survivor", engine: "claude" });
    expect(interrupted).toContain("survivor");
  });

  it("re-validates ownership and the cwd allowlist before adopting", async () => {
    await routeForTest("GET", "/sessions/survivor/read");
    const call = attachCalls.at(-1);
    expect(call?.engine).toBe("claude");
    expect(Array.isArray(call?.allowlist)).toBe(true);
  });

  it("still refuses a name this installation does not own", async () => {
    const send = await routeForTest("POST", "/sessions/not-ours/send", { text: "hi" });
    expect(send.status).toBe(409);
    expect(send.body).toMatchObject({ error: expect.stringContaining("not live") });

    const interrupt = await routeForTest("POST", "/sessions/not-ours/interrupt");
    expect(interrupt.status).toBe(409);

    const read = await routeForTest("GET", "/sessions/not-ours/read");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ live: false, idle: true });
  });
});
