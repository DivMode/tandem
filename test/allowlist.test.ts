import { describe, it, expect } from "vitest";
import { isCwdAllowed, buildAllowlist } from "../bridge/sessions.ts";

describe("isCwdAllowed (the cwd trust boundary)", () => {
  const allow = ["/tmp/work", "/private/tmp/work"]; // realpath of /tmp on macOS is /private/tmp

  it("accepts an exact allowlisted dir", () => {
    expect(isCwdAllowed("/tmp/work", allow)).toBe(true);
  });

  it("accepts a subdirectory of an allowlisted dir", () => {
    expect(isCwdAllowed("/tmp/work/project", allow)).toBe(true);
  });

  it("rejects a sibling that shares a prefix string but not a path boundary", () => {
    expect(isCwdAllowed("/tmp/work-evil", allow)).toBe(false);
  });

  it("rejects a path outside every base", () => {
    expect(isCwdAllowed("/etc", allow)).toBe(false);
  });

  it("rejects ../ traversal out of an allowlisted base", () => {
    expect(isCwdAllowed("/tmp/work/../../etc", allow)).toBe(false);
  });
});

describe("buildAllowlist", () => {
  it("parses an explicit colon-separated env value", () => {
    const roots = buildAllowlist("/tmp/work:/private/tmp/other", "/Users/test");
    expect(roots.length).toBeGreaterThanOrEqual(1);
  });
});
