import { describe, it, expect, vi } from "vitest";
import type { TerminalSessionLike } from "../bridge/engines/terminal-adapter.ts";
import type { TerminalBackend, TerminalEngineId } from "../bridge/terminal-backend.ts";

/**
 * Two concurrent requests (e.g. a racing send + read, or read + interrupt)
 * for the same backend-owned session that is NOT yet in this process's
 * registry must converge on a single re-adopted DrivableSession, not each
 * build their own independent wrapper around their own `attachExisting`
 * call. Two independent wrappers around the same underlying Herdr agent
 * would track cursor/read state independently, and whichever `registerLive`
 * landed last would silently orphan the other caller's wrapper mid-request.
 *
 * `attachExisting` is gated behind a real (setTimeout-based) delay here so
 * the two requests are GENUINELY in flight at the same time — this is not
 * relying on same-tick JS scheduling, it proves the dedup holds across an
 * actual async gap.
 */

const attachCalls: Array<{ name: string; engine: TerminalEngineId; allowlist: string[] }> = [];
let terminalInstancesCreated = 0;
const servedByInstance: number[] = [];

function fakeTerminal(name: string, instanceId: number): TerminalSessionLike {
  return {
    name,
    cwd: "/allowed/project",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "fake attach",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text) => {
      servedByInstance.push(instanceId);
      return { report: `echo:${text}`, cursor: 1, status: "done" as const };
    },
    readSince: async (cursor) => {
      servedByInstance.push(instanceId);
      return { text: cursor === 0 ? "fresh" : "", cursor: 1, idle: true };
    },
    applyControls: async () => [],
    interrupt: async () => {
      servedByInstance.push(instanceId);
    },
    close: async () => {
      servedByInstance.push(instanceId);
    },
  };
}

const backend: TerminalBackend = {
  kind: "herdr",
  spawn: async () => {
    throw new Error("spawn must not be called by adoption");
  },
  attachExisting: async (name, engine, allowlist) => {
    attachCalls.push({ name, engine, allowlist });
    if (name !== "survivor") return undefined;
    // Real async gap: any second concurrent caller that (incorrectly) called
    // attachExisting independently would race in here too, and we'd see
    // attachCalls.length > 1 below.
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminalInstancesCreated += 1;
    return fakeTerminal(name, terminalInstancesCreated);
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

describe("concurrent re-adoption of a not-yet-registered session", () => {
  it("send + read racing for the same unregistered name share one adoption", async () => {
    const [sendRes, readRes] = await Promise.all([
      routeForTest("POST", "/sessions/survivor/send", { text: "hello" }),
      routeForTest("GET", "/sessions/survivor/read"),
    ]);

    expect(sendRes.status).toBe(200);
    expect(readRes.status).toBe(200);
    // attachExisting (the actual backend re-adoption call) only ran once.
    expect(attachCalls).toHaveLength(1);
    // Only one TerminalSessionLike wrapper was ever constructed.
    expect(terminalInstancesCreated).toBe(1);
    // Both requests were served BY that same wrapper instance, not two
    // independent ones racing to overwrite each other in the registry.
    expect(new Set(servedByInstance)).toEqual(new Set([1]));
  });

  it("a third request after adoption settles hits the fast already-registered path (no further attachExisting calls)", async () => {
    const before = attachCalls.length;
    const res = await routeForTest("POST", "/sessions/survivor/interrupt");
    expect(res.status).toBe(200);
    expect(attachCalls.length).toBe(before);
  });
});
