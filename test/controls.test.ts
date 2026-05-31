import { describe, it, expect, afterEach } from "vitest";
import {
  validateModel,
  validateEffort,
  skipPermissionsEnabled,
  EFFORT_LEVELS,
  MODEL_ALIASES,
} from "../bridge/terminal-session.ts";

describe("validateModel", () => {
  it("accepts every documented alias (case-insensitive, normalized)", () => {
    for (const a of MODEL_ALIASES) expect(validateModel(a.toUpperCase())).toBe(a);
  });
  it("accepts a full claude-* id including the [1m] variant", () => {
    expect(validateModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(validateModel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]");
  });
  it("rejects unsupported values with a clear error (never silent)", () => {
    expect(() => validateModel("gpt-4")).toThrow(/unsupported model/);
    expect(() => validateModel("")).toThrow();
  });
});

describe("validateEffort", () => {
  it("accepts every documented level", () => {
    for (const e of EFFORT_LEVELS) expect(validateEffort(e)).toBe(e);
  });
  it("rejects unsupported values with a clear error", () => {
    expect(() => validateEffort("turbo")).toThrow(/unsupported effort/);
  });
});

describe("skipPermissionsEnabled (default ON, env-overridable)", () => {
  const prev = process.env.TANDEM_SKIP_PERMISSIONS;
  afterEach(() => {
    if (prev === undefined) delete process.env.TANDEM_SKIP_PERMISSIONS;
    else process.env.TANDEM_SKIP_PERMISSIONS = prev;
  });
  it("defaults to true when unset", () => {
    delete process.env.TANDEM_SKIP_PERMISSIONS;
    expect(skipPermissionsEnabled()).toBe(true);
  });
  it("is disabled only by 0/false/no/off", () => {
    for (const v of ["0", "false", "no", "off", "OFF", " False "]) {
      process.env.TANDEM_SKIP_PERMISSIONS = v;
      expect(skipPermissionsEnabled()).toBe(false);
    }
    for (const v of ["1", "true", "yes", "on", ""]) {
      process.env.TANDEM_SKIP_PERMISSIONS = v;
      expect(skipPermissionsEnabled()).toBe(true);
    }
  });
});
