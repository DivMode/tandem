import { describe, it, expect } from "vitest";
import { describeReadiness } from "../bridge/terminal-session.ts";

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
