import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetEnrollmentStore } from "../../bridge/fleet-enrollment.ts";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function newStore(): Promise<{ directory: string; store: FleetEnrollmentStore }> {
  const directory = mkdtempSync(join(tmpdir(), "tandem-enrollment-"));
  directories.push(directory);
  return { directory, store: await FleetEnrollmentStore.open(directory) };
}

describe("one-time fleet enrollment store", () => {
  it("persists only a digest and allows exactly one concurrent consumer", async () => {
    const { directory, store } = await newStore();
    const invitation = await store.create();
    const recordName = readdirSync(directory).find((name) => name.endsWith(".json"));
    expect(recordName).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(readFileSync(join(directory, recordName!), "utf8")).not.toContain(invitation.token);

    const results = await Promise.all(Array.from({ length: 8 }, () => store.consume(invitation.token)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.consume(invitation.token)).toBe(false);
  });

  it("rejects expired, revoked, malformed, and unknown invitations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { store } = await newStore();
    const expired = await store.create(60_000);
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect(await store.consume(expired.token)).toBe(false);

    const revoked = await store.create();
    expect(await store.revoke(revoked.token)).toBe(true);
    expect(await store.consume(revoked.token)).toBe(false);
    expect(await store.consume("bad")).toBe(false);
    expect(await store.consume("x".repeat(43))).toBe(false);
  });
});
