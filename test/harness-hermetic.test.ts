import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { clearedVariables } from "./setup-hermetic-env.ts";

/**
 * Proof that `npm test` is hermetic wherever it runs.
 *
 * Before this harness existed, running the suite from inside a live
 * Tandem/Herdr worker inherited that worker's TANDEM_* and CCM_* configuration and
 * four baseline suites failed, so every invocation needed a hand-written
 * `env -u TANDEM_TERMINAL_BACKEND -u TANDEM_CWD_ALLOWLIST ...` prefix. These
 * assertions are what makes the bare command trustworthy again.
 */

/** The variables whose ambient presence actually broke baseline suites. */
const MUST_BE_UNSET = [
  "TANDEM_TERMINAL_BACKEND",
  "TANDEM_CWD_ALLOWLIST",
  "CCM_CWD_ALLOWLIST",
  "CCM_DEFAULT_CWD",
  "TANDEM_DEFAULT_CWD",
  "TANDEM_ENABLED_ENGINES",
  "TANDEM_ALLOW_BYPASS",
  "TANDEM_NTFY_TOPIC",
  "TANDEM_DONE_WEBHOOK",
  // Would silently change the `device` field on every recorded foreman event.
  "TANDEM_DEVICE_ID",
];

describe("the test harness is hermetic", () => {
  it("clears every ambient TANDEM_* and CCM_* variable except the state root", () => {
    for (const key of MUST_BE_UNSET) {
      expect(process.env[key], `${key} must not leak in from the surrounding shell`).toBeUndefined();
    }
    const leaked = Object.keys(process.env).filter(
      (k) => (k.startsWith("TANDEM_") || k.startsWith("CCM_")) && k !== "TANDEM_STATE_DIR",
    );
    expect(leaked).toEqual([]);
  });

  it("still lets an individual test set its own value", () => {
    expect(process.env.TANDEM_DEVICE_ID).toBeUndefined();
    process.env.TANDEM_DEVICE_ID = "studio";
    try {
      expect(process.env.TANDEM_DEVICE_ID).toBe("studio");
    } finally {
      delete process.env.TANDEM_DEVICE_ID;
    }
  });

  it("points the private state root at a temp directory, never the real home", () => {
    const stateDir = process.env.TANDEM_STATE_DIR;
    expect(stateDir).toBeTruthy();
    expect(stateDir!.startsWith(`${homedir()}/.tandem`)).toBe(false);
    expect(existsSync(stateDir!)).toBe(true);
    expect(statSync(stateDir!).mode & 0o077).toBe(0);
    // Inside the run-scoped root that globalSetup removes on teardown.
    expect(stateDir!.startsWith(tmpdir()) || stateDir!.includes("node_modules")).toBe(true);
  });

  it("reports what it cleared, so a surprising clear is visible rather than silent", () => {
    expect(Array.isArray(clearedVariables)).toBe(true);
    expect(clearedVariables).not.toContain("TANDEM_STATE_DIR");
  });
});
