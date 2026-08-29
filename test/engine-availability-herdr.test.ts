import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectExecutableOnPath } from "../bridge/engine-registry.ts";

/**
 * Engine availability must be judged in the environment the agent will run in.
 *
 * Under the Herdr backend that is TANDEM_HERDR_WORKSPACE_PATH, which Tandem's
 * own process never has on its PATH. Probing with `which` alone made that
 * setting unreachable — the engine was refused before any workspace could be
 * created, so the one mechanism for making an agent visible could never make it
 * visible. Measured 2026-08-29 against the ChatGPT desktop app's bundled Codex.
 *
 * These tests use a real temporary directory and a real mode bit rather than a
 * fake, because the thing under test is exactly "is this file executable".
 */

const saved = {
  backend: process.env.TANDEM_TERMINAL_BACKEND,
  path: process.env.TANDEM_HERDR_WORKSPACE_PATH,
};

afterEach(() => {
  process.env.TANDEM_TERMINAL_BACKEND = saved.backend;
  process.env.TANDEM_HERDR_WORKSPACE_PATH = saved.path;
});

function workspaceDirWith(name: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "tandem-engine-"));
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
  return dir;
}

describe("executable detection under the Herdr backend", () => {
  it("finds an engine that only exists in the configured workspace PATH", async () => {
    const dir = workspaceDirWith("tandem-fake-engine", 0o755);
    process.env.TANDEM_TERMINAL_BACKEND = "herdr";
    process.env.TANDEM_HERDR_WORKSPACE_PATH = dir;

    // Not on this process's PATH, so `which` alone would answer false.
    expect(await detectExecutableOnPath("tandem-fake-engine")).toBe(true);
  });

  it("ignores a non-executable file of the right name", async () => {
    const dir = workspaceDirWith("tandem-fake-engine", 0o644);
    process.env.TANDEM_TERMINAL_BACKEND = "herdr";
    process.env.TANDEM_HERDR_WORKSPACE_PATH = dir;

    expect(await detectExecutableOnPath("tandem-fake-engine")).toBe(false);
  });

  it("ignores the workspace PATH entirely under the tmux backend", async () => {
    const dir = workspaceDirWith("tandem-fake-engine", 0o755);
    process.env.TANDEM_TERMINAL_BACKEND = "tmux";
    process.env.TANDEM_HERDR_WORKSPACE_PATH = dir;

    // Upstream behaviour is unchanged: tmux spawns inherit this process's PATH.
    expect(await detectExecutableOnPath("tandem-fake-engine")).toBe(false);
  });

  it("refuses relative entries rather than resolving them against the cwd", async () => {
    process.env.TANDEM_TERMINAL_BACKEND = "herdr";
    process.env.TANDEM_HERDR_WORKSPACE_PATH = "relative/bin";

    expect(await detectExecutableOnPath("tandem-fake-engine")).toBe(false);
  });

  it("still falls back to PATH for an engine that is genuinely installed", async () => {
    process.env.TANDEM_TERMINAL_BACKEND = "herdr";
    process.env.TANDEM_HERDR_WORKSPACE_PATH = workspaceDirWith("unrelated", 0o755);

    // `sh` is on PATH on every supported host; the workspace PATH does not have it.
    expect(await detectExecutableOnPath("sh")).toBe(true);
  });
});
