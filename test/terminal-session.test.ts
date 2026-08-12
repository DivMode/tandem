import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TerminalSession,
  canAdoptTerminalSession,
  describeReadiness,
  describeMarkerlessReadiness,
  stepStability,
  requiredStablePolls,
  INITIAL_STABILITY_STATE,
  type StabilityState,
} from "../bridge/terminal-session.ts";
import { CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR, SHELL_DESCRIPTOR } from "../bridge/drivable.ts";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TerminalSession provenance and spawn guards", () => {
  function dirs(): { allowed: string; outside: string } {
    const root = mkdtempSync(join(tmpdir(), "tandem-adopt-"));
    tempRoots.push(root);
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    return { allowed, outside };
  }

  it("accepts adoption only when engine, owner, and real cwd all match", () => {
    const { allowed } = dirs();
    expect(
      canAdoptTerminalSession(
        { engine: "codex", owner: "owner-a" },
        "codex",
        "owner-a",
        allowed,
        [allowed],
      ),
    ).toBe(true);
  });

  it("refuses an engine-tag mismatch", () => {
    const { allowed } = dirs();
    expect(
      canAdoptTerminalSession(
        { engine: "claude", owner: "owner-a" },
        "codex",
        "owner-a",
        allowed,
        [allowed],
      ),
    ).toBe(false);
  });

  it("refuses a missing or mismatched owner", () => {
    const { allowed } = dirs();
    expect(canAdoptTerminalSession({ engine: "codex", owner: "" }, "codex", "owner-a", allowed, [allowed])).toBe(false);
    expect(canAdoptTerminalSession({ engine: "codex", owner: "owner-b" }, "codex", "owner-a", allowed, [allowed])).toBe(false);
  });

  it("refuses a matching session whose real cwd is outside the allowlist", () => {
    const { allowed, outside } = dirs();
    expect(
      canAdoptTerminalSession(
        { engine: "codex", owner: "owner-a" },
        "codex",
        "owner-a",
        outside,
        [allowed],
      ),
    ).toBe(false);
  });

  it("TerminalSession.spawn itself rejects Claude-only options before cwd or tmux access", async () => {
    const base = {
      name: "no-live-spawn",
      cwd: "/path-that-must-not-be-read",
      allowlist: [] as string[],
      descriptor: CODEX_DESCRIPTOR,
    };
    await expect(TerminalSession.spawn({ ...base, model: "opus" })).rejects.toThrow(/Claude-only/);
    await expect(TerminalSession.spawn({ ...base, effort: "high" })).rejects.toThrow(/Claude-only/);
    await expect(TerminalSession.spawn({ ...base, allowBypass: false })).rejects.toThrow(/Claude-only/);
  });
});

// describeReadiness turns the #1 silent boot failure ("no banner / commands don't
// go through") into an actionable message. It is pure (load/cpu injected), so we
// exercise every branch without spawning a real TUI.
describe("describeReadiness", () => {
  it("returns null when the prompt is present (session is ready)", () => {
    expect(describeReadiness("some output\n❯ ", 1.0, 8, "worker")).toBeNull();
    // ready even under high load — the prompt is what matters
    expect(describeReadiness("❯", 99.0, 8, "worker")).toBeNull();
  });

  it("flags a CPU-starved blank pane under high load with the load + remedy", () => {
    const msg = describeReadiness("", 97.0, 8, "p1exec");
    expect(msg).not.toBeNull();
    expect(msg).toContain('session "p1exec"');
    expect(msg).toContain("blank");
    expect(msg).toContain("overloaded");
    expect(msg).toContain("97.0");
    expect(msg).toContain("8 CPUs");
  });

  it("distinguishes blank vs. partial render in the message", () => {
    expect(describeReadiness("", 1.0, 8, "w")).toContain("blank");
    expect(describeReadiness("Welcome\nhalf a screen", 1.0, 8, "w")).toContain(
      "prompt never appeared",
    );
  });

  it("when load is normal, advises a terminal attach to kick the TUI (with the right target)", () => {
    const msg = describeReadiness("", 1.0, 8, "myname");
    expect(msg).not.toBeNull();
    expect(msg).not.toContain("overloaded");
    expect(msg).toContain("tmux attach -t ccm-myname");
  });

  it("treats load just above 1.5x CPUs as overloaded, and at/below as not", () => {
    // 8 CPUs -> threshold 12.0
    expect(describeReadiness("", 12.1, 8, "x")).toContain("overloaded");
    expect(describeReadiness("", 12.0, 8, "x")).not.toContain("overloaded");
  });

  it("does not divide-by-zero / mislabel when cpuCount is unknown (0)", () => {
    const msg = describeReadiness("", 50.0, 0, "x");
    expect(msg).not.toBeNull();
    expect(msg).not.toContain("overloaded");
  });
});

// requiredStablePolls: converts a descriptor's minStableMs policy into an
// observation count. The first observation is at t=0, so N time intervals
// require N+1 observations.
describe("requiredStablePolls", () => {
  it("includes the t=0 observation so elapsed stability never undershoots the policy", () => {
    expect(requiredStablePolls(CLAUDE_DESCRIPTOR, 750)).toBe(4); // 3 intervals = 2250ms
    expect(requiredStablePolls(CODEX_DESCRIPTOR, 750)).toBe(Math.ceil(5000 / 750) + 1); // 8
    expect(requiredStablePolls(SHELL_DESCRIPTOR, 750)).toBe(Math.ceil(1500 / 750) + 1); // 3
  });
  it("uses one observation for a zero-duration policy and two for any positive duration", () => {
    expect(requiredStablePolls({ id: "shell", minStableMs: 0 }, 750)).toBe(1);
    expect(requiredStablePolls({ id: "shell", minStableMs: 1 }, 750)).toBe(2);
  });
});

// stepStability is the pure state machine markerless (codex/shell) AND
// marker-based (claude) completion detection share. Binding — Phase 2
// correction B: "changing output is working, a short quiet pause is not
// enough for Codex, and sufficiently stable output can finish" — exercised
// here with captured/synthetic pane sequences, no live process required.
describe("stepStability — markerless (codex): stability-only, conservative window", () => {
  const required = requiredStablePolls(CODEX_DESCRIPTOR, 750); // 8 observations span 5.25s >= 5s floor

  it("changing output on every poll is always 'working', never idle", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    for (let i = 0; i < required + 3; i++) {
      const step = stepStability(`frame ${i}`, state, CODEX_DESCRIPTOR, required);
      expect(step.working).toBe(false); // codex has no marker; "working" is always false
      expect(step.idle).toBe(false); // but stablePolls resets each time output changes
      state = step.state;
    }
  });

  it("a short quiet pause (fewer polls than the 5s floor) is NOT enough to report done", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    const pane = "final output";
    for (let i = 0; i < required - 1; i++) {
      const step = stepStability(pane, state, CODEX_DESCRIPTOR, required);
      expect(step.idle).toBe(false);
      state = step.state;
    }
  });

  it("sufficiently stable output (>= the 5s floor of consecutive polls) reports done", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    const pane = "final output";
    let idle = false;
    for (let i = 0; i < required; i++) {
      const step = stepStability(pane, state, CODEX_DESCRIPTOR, required);
      idle = step.idle;
      state = step.state;
    }
    expect(idle).toBe(true);
  });

  it("output changing right before the stability window elapses resets the count", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    for (let i = 0; i < required - 1; i++) {
      state = stepStability("same pane", state, CODEX_DESCRIPTOR, required).state;
    }
    // One more poll, but the pane just changed — resets to stablePolls=1, not idle.
    const changed = stepStability("different pane now", state, CODEX_DESCRIPTOR, required);
    expect(changed.idle).toBe(false);
    expect(changed.state.stablePolls).toBe(1);
  });
});

describe("stepStability — markerless (shell): shorter conservative window", () => {
  it("3 stable observations spanning the 1.5s floor reports done", () => {
    const required = requiredStablePolls(SHELL_DESCRIPTOR, 750);
    let state: StabilityState = INITIAL_STABILITY_STATE;
    let idle = false;
    for (let i = 0; i < required; i++) {
      const step = stepStability("$ ", state, SHELL_DESCRIPTOR, required);
      idle = step.idle;
      state = step.state;
    }
    expect(idle).toBe(true);
  });
});

describe("stepStability — marker-based (claude): the working marker overrides stability", () => {
  it("the presence of the working marker is always 'working', regardless of pane stability", () => {
    let state: StabilityState = INITIAL_STABILITY_STATE;
    const pane = "thinking... (esc to interrupt)";
    for (let i = 0; i < 5; i++) {
      const step = stepStability(pane, state, CLAUDE_DESCRIPTOR, requiredStablePolls(CLAUDE_DESCRIPTOR, 750));
      expect(step.working).toBe(true);
      expect(step.idle).toBe(false);
      state = step.state;
    }
  });

  it("once the marker clears, idle requires the same stability window as any other descriptor", () => {
    const required = requiredStablePolls(CLAUDE_DESCRIPTOR, 750);
    let state = stepStability("thinking... (esc to interrupt)", INITIAL_STABILITY_STATE, CLAUDE_DESCRIPTOR, required).state;
    let idle = false;
    for (let i = 0; i < required; i++) {
      const step = stepStability("❯ ", state, CLAUDE_DESCRIPTOR, required);
      idle = step.idle;
      state = step.state;
    }
    expect(idle).toBe(true);
  });
});
