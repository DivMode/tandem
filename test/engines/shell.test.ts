import { describe, it, expect } from "vitest";
import { ShellSession } from "../../bridge/engines/shell.ts";
import type { TerminalSessionLike } from "../../bridge/engines/terminal-adapter.ts";

/**
 * Adapter contract tests (binding — Phase 1 plan review amendment #6, still
 * binding in Phase 2): drive ShellSession entirely through an INJECTED fake.
 * No tmux, no real shell process required.
 */

function makeFakeTerminal(overrides: Partial<TerminalSessionLike> = {}): TerminalSessionLike {
  return {
    name: "fake-shell",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t ccm-fake-shell",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text: string) => ({ report: `report for: ${text}`, cursor: 7, status: "done" as const }),
    readSince: async (cursor: number) => ({ text: "ls output", cursor: cursor + 5, idle: true }),
    applyControls: async () => [],
    interrupt: async () => {},
    close: async () => {},
    ...overrides,
  };
}

describe("ShellSession — DrivableSession contract (injected fake)", () => {
  it("engine is 'shell'; id/cwd mirror the injected terminal", () => {
    const session = new ShellSession(makeFakeTerminal());
    expect(session.engine).toBe("shell");
    expect(session.id).toBe("fake-shell");
    expect(session.cwd).toBe("/tmp/work");
  });

  it("send(text) with no options calls terminal.send() directly — arbitrary shell command execution", async () => {
    const session = new ShellSession(makeFakeTerminal());
    const result = await session.send("ls -la");
    expect(result).toEqual({ report: "report for: ls -la", cursor: 7, status: "done" });
  });

  it("send(text, {model|effort}) REJECTS — Claude-only options (binding correction C)", async () => {
    const session = new ShellSession(makeFakeTerminal());
    await expect(session.send("ls", { model: "opus" })).rejects.toThrow(/Claude-only/);
    await expect(session.send("ls", { effort: "high" })).rejects.toThrow(/Claude-only/);
  });
});

describe("ShellSession — spawn/attachExisting/exists (injected factory)", () => {
  it("spawn() forwards SHELL_DESCRIPTOR (no executable — default login shell) to the injected spawnFn", async () => {
    const fake = makeFakeTerminal({ name: "brand-new" });
    let seenOpts: unknown;
    const spawnFn = async (opts: unknown) => {
      seenOpts = opts;
      return fake;
    };
    const session = await ShellSession.spawn({ name: "brand-new", cwd: "/tmp/proj", allowlist: ["/tmp"] }, spawnFn);
    expect(session.engine).toBe("shell");
    const descriptor = (seenOpts as { descriptor: { id: string; executable?: string } }).descriptor;
    expect(descriptor.id).toBe("shell");
    expect(descriptor.executable).toBeUndefined();
  });

  it("attachExisting() wraps a re-adopted terminal when the injected attachFn finds one", async () => {
    const fake = makeFakeTerminal({ name: "survived-restart" });
    const session = await ShellSession.attachExisting("survived-restart", ["/tmp"], async () => fake);
    expect(session?.id).toBe("survived-restart");
    expect(session?.engine).toBe("shell");
  });

  it("attachExisting() returns undefined when nothing is found", async () => {
    const session = await ShellSession.attachExisting("gone", ["/tmp"], async () => undefined);
    expect(session).toBeUndefined();
  });

  it("exists() forwards to the injected existsFn", async () => {
    expect(await ShellSession.exists("present", async () => true)).toBe(true);
    expect(await ShellSession.exists("absent", async () => false)).toBe(false);
  });
});
