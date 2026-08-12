import { describe, it, expect } from "vitest";
import { ClaudeSession, type TerminalSessionLike } from "../../bridge/engines/claude.ts";

/**
 * Adapter contract tests (binding — Phase 1 plan review amendment #6): drive
 * ClaudeSession entirely through an INJECTED fake TerminalSessionLike. No tmux,
 * no real `claude` process, no live subscription — deterministic and CI-safe.
 * A real tmux/Claude run is a separate manual smoke test, never required here.
 */

interface Call {
  method: string;
  args: unknown[];
}

function makeFakeTerminal(overrides: Partial<TerminalSessionLike> = {}) {
  const calls: Call[] = [];
  const fake: TerminalSessionLike = {
    name: "fake-session",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => {
      calls.push({ method: "attachHint", args: [] });
      return "tmux attach -t ccm-fake-session";
    },
    isAlive: async () => {
      calls.push({ method: "isAlive", args: [] });
      return true;
    },
    isCurrentlyWorking: async () => {
      calls.push({ method: "isCurrentlyWorking", args: [] });
      return false;
    },
    send: async (text: string) => {
      calls.push({ method: "send", args: [text] });
      return { report: `report for: ${text}`, cursor: 42, status: "done" as const };
    },
    readSince: async (cursor: number) => {
      calls.push({ method: "readSince", args: [cursor] });
      return { text: "some output", cursor: cursor + 10, idle: true };
    },
    applyControls: async (controls: { model?: string; effort?: string }) => {
      calls.push({ method: "applyControls", args: [controls] });
      const applied: string[] = [];
      if (controls.effort !== undefined) applied.push(`effort=${controls.effort}`);
      if (controls.model !== undefined) applied.push(`model=${controls.model}`);
      return applied;
    },
    interrupt: async () => {
      calls.push({ method: "interrupt", args: [] });
    },
    close: async () => {
      calls.push({ method: "close", args: [] });
    },
    ...overrides,
  };
  return { fake, calls };
}

describe("ClaudeSession — DrivableSession contract (injected fake)", () => {
  it("id/cwd/engine/ready/readinessWarning mirror the injected terminal", () => {
    const { fake } = makeFakeTerminal({ readinessWarning: "session did not reach the prompt" });
    const session = new ClaudeSession(fake);
    expect(session.engine).toBe("claude");
    expect(session.id).toBe("fake-session");
    expect(session.cwd).toBe("/tmp/work");
    expect(session.ready).toBe(true);
    expect(session.readinessWarning).toBe("session did not reach the prompt");
  });

  it("attachHint() delegates to the terminal", () => {
    const { fake } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    expect(session.attachHint()).toBe("tmux attach -t ccm-fake-session");
  });

  it("isAlive() delegates to the terminal's isAlive()", async () => {
    const { fake: aliveTrue } = makeFakeTerminal();
    expect(await new ClaudeSession(aliveTrue).isAlive()).toBe(true);
    const { fake: aliveFalse } = makeFakeTerminal({ isAlive: async () => false });
    expect(await new ClaudeSession(aliveFalse).isAlive()).toBe(false);
  });

  it("isWorking() delegates to the terminal's isCurrentlyWorking()", async () => {
    const { fake, calls } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    expect(await session.isWorking()).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["isCurrentlyWorking"]);
  });

  it("send(text) with no options calls terminal.send() directly — no applyControls", async () => {
    const { fake, calls } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    const result = await session.send("do the thing");
    expect(result).toEqual({ report: "report for: do the thing", cursor: 42, status: "done" });
    expect(calls.map((c) => c.method)).toEqual(["send"]);
  });

  it("send(text, {model|effort}) applies controls BEFORE sending — generic bounded SendResult, no Claude-only escape hatch", async () => {
    const { fake, calls } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    const result = await session.send("go", { model: "opus", effort: "high" });
    expect(calls.map((c) => c.method)).toEqual(["applyControls", "send"]);
    expect(calls[0].args[0]).toEqual({ model: "opus", effort: "high" });
    expect(calls[1].args[0]).toBe("go");
    // The result shape is the generic bounded contract: status/report/cursor only.
    expect(Object.keys(result).sort()).toEqual(["cursor", "report", "status"]);
  });

  it("send() returning status:'running' is passed through unchanged (bounded, never blocks internally)", async () => {
    const { fake } = makeFakeTerminal({
      send: async () => ({ report: "", cursor: 7, status: "running" as const }),
    });
    const session = new ClaudeSession(fake);
    const result = await session.send("go");
    expect(result).toEqual({ report: "", cursor: 7, status: "running" });
  });

  it("read() with no options defaults cursor to 0", async () => {
    const { fake, calls } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    const result = await session.read();
    expect(calls).toEqual([{ method: "readSince", args: [0] }]);
    expect(result).toEqual({ text: "some output", cursor: 10, idle: true });
  });

  it("read({cursor}) forwards the cursor", async () => {
    const { fake, calls } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    await session.read({ cursor: 100 });
    expect(calls).toEqual([{ method: "readSince", args: [100] }]);
  });

  it("interrupt() delegates to the terminal", async () => {
    const { fake, calls } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    await session.interrupt();
    expect(calls.map((c) => c.method)).toEqual(["interrupt"]);
  });

  it("close() delegates to the terminal", async () => {
    const { fake, calls } = makeFakeTerminal();
    const session = new ClaudeSession(fake);
    await session.close();
    expect(calls.map((c) => c.method)).toEqual(["close"]);
  });
});

// spawn/attachExisting/exists regression tests: an injected factory function
// stands in for TerminalSession.spawn/attachExisting/exists, so these are
// exercised deterministically too — no tmux, no live Claude process required.
describe("ClaudeSession — spawn/attachExisting/exists (injected factory)", () => {
  it("spawn() calls the injected spawnFn with the given options and wraps the result", async () => {
    const { fake } = makeFakeTerminal({ name: "brand-new", cwd: "/tmp/proj" });
    const spawnCalls: unknown[] = [];
    const spawnFn = async (opts: unknown) => {
      spawnCalls.push(opts);
      return fake;
    };
    const opts = { name: "brand-new", cwd: "/tmp/proj", allowlist: ["/tmp"] };
    const session = await ClaudeSession.spawn(opts, spawnFn);
    expect(spawnCalls).toEqual([opts]);
    expect(session.id).toBe("brand-new");
    expect(session.cwd).toBe("/tmp/proj");
    expect(session.engine).toBe("claude");
  });

  it("spawn() propagates a rejection from the injected spawnFn (e.g. cwd not allowed)", async () => {
    const spawnFn = async () => {
      throw new Error("cwd not allowed: /etc");
    };
    await expect(ClaudeSession.spawn({ name: "x", cwd: "/etc", allowlist: ["/tmp"] }, spawnFn)).rejects.toThrow(
      "cwd not allowed",
    );
  });

  it("attachExisting() wraps a re-adopted terminal when the injected attachFn finds one", async () => {
    const { fake } = makeFakeTerminal({ name: "survived-restart" });
    const attachFn = async (name: string, allowlist: string[]) => {
      expect(name).toBe("survived-restart");
      expect(allowlist).toEqual(["/tmp"]);
      return fake;
    };
    const session = await ClaudeSession.attachExisting("survived-restart", ["/tmp"], attachFn);
    expect(session?.id).toBe("survived-restart");
  });

  it("attachExisting() returns undefined when the injected attachFn finds nothing (e.g. cwd outside allowlist)", async () => {
    const attachFn = async () => undefined;
    const session = await ClaudeSession.attachExisting("gone", ["/tmp"], attachFn);
    expect(session).toBeUndefined();
  });

  it("exists() forwards to the injected existsFn", async () => {
    expect(await ClaudeSession.exists("present", async () => true)).toBe(true);
    expect(await ClaudeSession.exists("absent", async () => false)).toBe(false);
  });
});
