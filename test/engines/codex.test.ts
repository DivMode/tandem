import { describe, it, expect } from "vitest";
import { CodexSession } from "../../bridge/engines/codex.ts";
import type { TerminalSessionLike } from "../../bridge/engines/terminal-adapter.ts";

/**
 * Adapter contract tests (binding — Phase 1 plan review amendment #6, still
 * binding in Phase 2): drive CodexSession entirely through an INJECTED fake
 * TerminalSessionLike / spawn-attach-exists factory. No tmux, no real `codex`
 * process required.
 */

function makeFakeTerminal(overrides: Partial<TerminalSessionLike> = {}): TerminalSessionLike {
  return {
    name: "fake-codex",
    cwd: "/tmp/work",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "tmux attach -t ccm-fake-codex",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text: string) => ({ report: `report for: ${text}`, cursor: 42, status: "done" as const }),
    readSince: async (cursor: number) => ({ text: "some output", cursor: cursor + 10, idle: true }),
    applyControls: async () => [],
    interrupt: async () => {},
    close: async () => {},
    ...overrides,
  };
}

describe("CodexSession — DrivableSession contract (injected fake)", () => {
  it("engine is 'codex'; id/cwd mirror the injected terminal", () => {
    const session = new CodexSession(makeFakeTerminal());
    expect(session.engine).toBe("codex");
    expect(session.id).toBe("fake-codex");
    expect(session.cwd).toBe("/tmp/work");
  });

  it("send(text) with no options calls terminal.send() directly", async () => {
    const session = new CodexSession(makeFakeTerminal());
    const result = await session.send("do the thing");
    expect(result).toEqual({ report: "report for: do the thing", cursor: 42, status: "done" });
  });

  it("send(text, {model}) REJECTS — model/effort are Claude-only (binding correction C)", async () => {
    const session = new CodexSession(makeFakeTerminal());
    await expect(session.send("go", { model: "opus" })).rejects.toThrow(/Claude-only/);
  });

  it("send(text, {effort}) REJECTS — model/effort are Claude-only (binding correction C)", async () => {
    const session = new CodexSession(makeFakeTerminal());
    await expect(session.send("go", { effort: "high" })).rejects.toThrow(/Claude-only/);
  });

  it("read()/interrupt()/close() delegate to the terminal", async () => {
    const session = new CodexSession(makeFakeTerminal());
    expect(await session.read()).toEqual({ text: "some output", cursor: 10, idle: true });
    await session.interrupt();
    await session.close();
  });
});

describe("CodexSession — spawn/attachExisting/exists (injected factory)", () => {
  it("spawn() forwards CODEX_DESCRIPTOR to the injected spawnFn", async () => {
    const fake = makeFakeTerminal({ name: "brand-new" });
    let seenOpts: unknown;
    const spawnFn = async (opts: unknown) => {
      seenOpts = opts;
      return fake;
    };
    const session = await CodexSession.spawn({ name: "brand-new", cwd: "/tmp/proj", allowlist: ["/tmp"] }, spawnFn);
    expect(session.engine).toBe("codex");
    expect((seenOpts as { descriptor: { id: string } }).descriptor.id).toBe("codex");
  });

  it("attachExisting() wraps a re-adopted terminal when the injected attachFn finds one", async () => {
    const fake = makeFakeTerminal({ name: "survived-restart" });
    const session = await CodexSession.attachExisting("survived-restart", ["/tmp"], async () => fake);
    expect(session?.id).toBe("survived-restart");
    expect(session?.engine).toBe("codex");
  });

  it("attachExisting() returns undefined when nothing is found", async () => {
    const session = await CodexSession.attachExisting("gone", ["/tmp"], async () => undefined);
    expect(session).toBeUndefined();
  });

  it("exists() forwards to the injected existsFn", async () => {
    expect(await CodexSession.exists("present", async () => true)).toBe(true);
    expect(await CodexSession.exists("absent", async () => false)).toBe(false);
  });
});
