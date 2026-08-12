import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateOwnerId, makeOwnerIdProvider } from "../bridge/ownership.ts";

// Every test uses a fresh temp dir — NEVER the real ~/.tandem state (binding —
// Phase 2 correction A: "Tests must use injected temp paths/providers... Never
// read or alter the real home state during tests.").
async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tandem-owner-test-"));
}

describe("loadOrCreateOwnerId", () => {
  it("creates a new id when none exists, as a non-empty hex string", async () => {
    const dir = await tempStateDir();
    const id = await loadOrCreateOwnerId(dir);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists the id at 0600 inside the state dir", async () => {
    const dir = await tempStateDir();
    await loadOrCreateOwnerId(dir);
    const st = await stat(join(dir, "owner-id"));
    expect(st.mode & 0o777).toBe(0o600);
    const raw = (await readFile(join(dir, "owner-id"), "utf8")).trim();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the SAME id on a second call (does not regenerate)", async () => {
    const dir = await tempStateDir();
    const first = await loadOrCreateOwnerId(dir);
    const second = await loadOrCreateOwnerId(dir);
    expect(second).toBe(first);
  });

  it("two different state dirs get two different ids", async () => {
    const a = await loadOrCreateOwnerId(await tempStateDir());
    const b = await loadOrCreateOwnerId(await tempStateDir());
    expect(a).not.toBe(b);
  });

  it("creates the state dir itself if missing (mkdir -p semantics)", async () => {
    const parent = await tempStateDir();
    const nested = join(parent, "nested", "state");
    const id = await loadOrCreateOwnerId(nested);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publishes one stable winner across concurrent first-run callers", async () => {
    const dir = await tempStateDir();
    const ids = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateOwnerId(dir)));
    expect(new Set(ids).size).toBe(1);
    expect((await readFile(join(dir, "owner-id"), "utf8")).trim()).toBe(ids[0]);
  });

  it("refuses a malformed existing owner id instead of silently rotating it", async () => {
    const dir = await tempStateDir();
    await writeFile(join(dir, "owner-id"), "not-an-owner-id", { mode: 0o600 });
    await expect(loadOrCreateOwnerId(dir)).rejects.toThrow(/malformed/);
    expect(await readFile(join(dir, "owner-id"), "utf8")).toBe("not-an-owner-id");
  });
});

describe("makeOwnerIdProvider", () => {
  it("memoizes: repeated calls resolve to the same id without re-reading disk state race", async () => {
    const dir = await tempStateDir();
    const provider = makeOwnerIdProvider(dir);
    const [a, b, c] = await Promise.all([provider(), provider(), provider()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("a provider bound to a different dir yields a different id", async () => {
    const providerA = makeOwnerIdProvider(await tempStateDir());
    const providerB = makeOwnerIdProvider(await tempStateDir());
    expect(await providerA()).not.toBe(await providerB());
  });
});
