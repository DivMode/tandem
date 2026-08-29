import { describe, it, expect, vi } from "vitest";
import type { TerminalSessionLike } from "../bridge/engines/terminal-adapter.ts";
import type { TerminalBackend, TerminalEngineId } from "../bridge/terminal-backend.ts";

/**
 * close_session must close a session that survived a bridge restart.
 *
 * The registry is per-process, so a session opened before a restart is not in
 * it — and open_session already re-adopts exactly that case through the
 * backend. Before this was fixed, close took the registry as the whole truth
 * and answered `alreadyClosed: true` while the terminal kept running: measured
 * 2026-08-29 against a real Herdr backend, where six workspaces from earlier
 * runs had each been reported closed and were each still live.
 *
 * Everything here is injected. No tmux, no Herdr, no real terminal.
 */

const closed: string[] = [];
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
    send: async () => ({ report: "", cursor: 0, status: "done" as const }),
    readSince: async () => ({ text: "", cursor: 0, idle: true }),
    applyControls: async () => [],
    interrupt: async () => {},
    close: async () => {
      closed.push(name);
    },
  };
}

const backend: TerminalBackend = {
  kind: "herdr",
  spawn: async () => {
    throw new Error("spawn must not be called by close");
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

describe("close_session re-adopts a session that outlived the bridge", () => {
  it("closes an owned session that is not in this process's registry", async () => {
    const res = await routeForTest("POST", "/sessions/survivor/close");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "survivor", engine: "claude" });
    // The whole point: the terminal was actually closed, not merely reported.
    expect(closed).toContain("survivor");
    expect(res.body).not.toHaveProperty("alreadyClosed");
  });

  it("re-validates ownership and the cwd allowlist before closing", async () => {
    await routeForTest("POST", "/sessions/survivor/close");
    const call = attachCalls.at(-1);
    expect(call?.engine).toBe("claude");
    // Adoption is what enforces the trust boundary, so it must receive the
    // real allowlist rather than close bypassing it.
    expect(Array.isArray(call?.allowlist)).toBe(true);
  });

  it("stays idempotent for a name this installation does not own", async () => {
    const before = closed.length;
    const res = await routeForTest("POST", "/sessions/not-ours/close");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: "not-ours", alreadyClosed: true });
    expect(closed.length).toBe(before);
  });
});
