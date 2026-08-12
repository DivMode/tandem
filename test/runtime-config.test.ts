import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProtectedRuntimeConfigFromEnv,
  readProtectedRuntimeConfig,
  writeProtectedRuntimeConfig,
} from "../src/runtime-config.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tandem-runtime-config-"));
  directories.push(directory);
  return directory;
}

describe("protected runtime configuration", () => {
  it("atomically writes and reads a 0600 JSON configuration", async () => {
    const file = join(temporaryDirectory(), "nested", "config.json");
    await writeProtectedRuntimeConfig(file, { TANDEM_PORT: "8787", TANDEM_CWD_ALLOWLIST: "/safe" });
    expect(await readProtectedRuntimeConfig(file)).toEqual({ TANDEM_PORT: "8787", TANDEM_CWD_ALLOWLIST: "/safe" });
    expect(readFileSync(file, "utf8")).not.toContain("tmp");
  });

  it("refuses broad modes, symlinks, malformed JSON, and invalid keys", async () => {
    const directory = temporaryDirectory();
    const broad = join(directory, "broad.json");
    writeFileSync(broad, '{}\n', { mode: 0o600 });
    chmodSync(broad, 0o644);
    await expect(readProtectedRuntimeConfig(broad)).rejects.toThrow(/permissions/);

    const target = join(directory, "target.json");
    writeFileSync(target, '{}\n', { mode: 0o600 });
    const link = join(directory, "link.json");
    symlinkSync(target, link);
    await expect(readProtectedRuntimeConfig(link)).rejects.toThrow(/regular file/);

    const realDirectory = join(directory, "real-directory");
    const linkedDirectory = join(directory, "linked-directory");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory);
    await expect(writeProtectedRuntimeConfig(join(linkedDirectory, "config.json"), { TANDEM_PORT: "8787" }))
      .rejects.toThrow(/directory is unsafe/);

    const malformed = join(directory, "malformed.json");
    writeFileSync(malformed, '{', { mode: 0o600 });
    await expect(readProtectedRuntimeConfig(malformed)).rejects.toThrow(/valid JSON/);

    const invalid = join(directory, "invalid.json");
    writeFileSync(invalid, '{"PATH":"bad"}', { mode: 0o600 });
    await expect(readProtectedRuntimeConfig(invalid)).rejects.toThrow(/invalid entry/);
  });

  it("does not override an explicit process environment value", async () => {
    const file = join(temporaryDirectory(), "config.json");
    await writeProtectedRuntimeConfig(file, { TANDEM_PORT: "8787", TANDEM_FLEET_PORT: "8788" });
    const env: NodeJS.ProcessEnv = { TANDEM_CONFIG_FILE: file, TANDEM_PORT: "9999" };
    expect(await loadProtectedRuntimeConfigFromEnv(env)).toBe(true);
    expect(env.TANDEM_PORT).toBe("9999");
    expect(env.TANDEM_FLEET_PORT).toBe("8788");
  });
});
