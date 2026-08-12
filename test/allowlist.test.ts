import { describe, it, expect } from "vitest";
import { isCwdAllowed, buildAllowlist, safeResolve } from "../bridge/sessions.ts";

describe("safeResolve", () => {
  it("preserves the first component of a nonexistent absolute path under root", () => {
    expect(safeResolve("/definitely-not-created-tandem-root/child")).toBe(
      "/definitely-not-created-tandem-root/child",
    );
  });
});

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

  it("fails closed when the allowlist is unset", () => {
    expect(buildAllowlist(undefined, "/Users/test")).toEqual([]);
  });

  it("fails closed when the allowlist is blank", () => {
    expect(buildAllowlist("   ", "/Users/test")).toEqual([]);
  });
});

// Session creation must FAIL CLOSED when the allowlist is empty, never fail
// open. isCwdAllowed([]) must reject every candidate, including cwds that would
// otherwise look "safe" (root, the resolved home dir itself, etc).
describe("isCwdAllowed — fail-closed on an empty allowlist", () => {
  it("rejects every candidate, including root and a plausible-looking home dir", () => {
    expect(isCwdAllowed("/", [])).toBe(false);
    expect(isCwdAllowed("/tmp", [])).toBe(false);
    expect(isCwdAllowed("/Users/anyone", [])).toBe(false);
  });
});

// An explicit-but-empty allowlist config (e.g. a bare separator) must resolve
// to zero roots and never silently fall back to a permissive home default.
describe("buildAllowlist — explicit-but-empty config fails closed (does not fall back to $HOME)", () => {
  it("a colon with nothing on either side resolves to an empty allowlist", () => {
    expect(buildAllowlist(":", "/Users/test")).toEqual([]);
  });
  it("that empty allowlist then rejects every cwd via isCwdAllowed", () => {
    const roots = buildAllowlist(":", "/Users/test");
    expect(isCwdAllowed("/Users/test", roots)).toBe(false);
    expect(isCwdAllowed("/tmp", roots)).toBe(false);
  });
});
