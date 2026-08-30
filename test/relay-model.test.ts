import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SpawnOptions } from "../bridge/terminal-session.ts";

/**
 * The relay's lead and worker are NEW CLAUDE SESSIONS, so the default-model
 * policy applies to them exactly as it does to open_session. They used to spawn
 * with no `model` at all, which silently handed the choice back to whatever the
 * host's `claude` CLI defaults to — the one place that matters most, since the
 * relay runs UNATTENDED with permission bypass on.
 *
 * NO REAL SESSION IS STARTED. TerminalSession is replaced: the lead spawn
 * returns a minimal fake and the worker spawn throws, so startRelay records
 * BOTH spawn option sets and then rejects before the background loop, the
 * manager memory seeding, or any tmux/claude process exists. bypass is faked
 * true rather than mutated in env, keeping this file's guard file-scoped.
 */

const spawnCalls: SpawnOptions[] = [];
const closedLeads: string[] = [];

class WorkerSpawnRefused extends Error {}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

vi.mock("../bridge/terminal-session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge/terminal-session.ts")>();
  return {
    ...actual,
    // The relay's own fail-fast guard is covered by test/relay-fail-fast.ts;
    // here it must pass so we reach the spawns.
    bypassPermissionsEnabled: () => true,
    TerminalSession: {
      spawn: async (opts: SpawnOptions) => {
        spawnCalls.push(opts);
        // First call = lead: succeed with a minimal fake. Second = worker:
        // refuse, so startRelay unwinds before starting any loop.
        if (spawnCalls.length === 1) {
          return { name: opts.name, close: async () => void closedLeads.push(opts.name) };
        }
        throw new WorkerSpawnRefused("worker spawn refused by test");
      },
    },
  };
});

const { startRelay } = await import("../bridge/relay.ts");
const { DEFAULT_CLAUDE_MODEL } = await import("../bridge/model-policy.ts");

beforeEach(() => {
  spawnCalls.length = 0;
  closedLeads.length = 0;
});

describe("relay spawns both sessions on the canonical default model", () => {
  it("passes model 'opus' to BOTH the lead and the worker spawn", async () => {
    await expect(startRelay({ goal: "g", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(WorkerSpawnRefused);

    expect(spawnCalls).toHaveLength(2);
    const [lead, worker] = spawnCalls;
    expect(lead!.name).toMatch(/-lead$/);
    expect(worker!.name).toMatch(/-worker$/);
    expect(lead!.model).toBe("opus");
    expect(worker!.model).toBe("opus");
    // Bound to the ONE canonical constant, not a second hand-written literal.
    expect(lead!.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(worker!.model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it("never leaves the model unset, which would defer the choice to host CLI config", async () => {
    await expect(startRelay({ goal: "g", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(WorkerSpawnRefused);
    for (const call of spawnCalls) {
      expect(call.model).toBeDefined();
      expect(call.model).not.toBe("default");
    }
  });

  it("leaves the relay's bypass and allowlist semantics untouched", async () => {
    await expect(startRelay({ goal: "g", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(WorkerSpawnRefused);
    for (const call of spawnCalls) {
      // Bypass still passed explicitly (never a silent per-spawn env re-read),
      // and the caller's allowlist still reaches spawn for cwd admission.
      expect(call.allowBypass).toBe(true);
      expect(call.allowlist).toEqual(["/tmp"]);
      expect(call.cwd).toBe("/tmp");
      // Effort is NOT set by the relay — this change adds a model, nothing else.
      expect(call.effort).toBeUndefined();
    }
  });

  it("still closes the lead when the worker fails, so a failed start leaks nothing", async () => {
    await expect(startRelay({ goal: "g", cwd: "/tmp", allowlist: ["/tmp"] })).rejects.toThrow(WorkerSpawnRefused);
    expect(closedLeads).toEqual([spawnCalls[0]!.name]);
  });
});
