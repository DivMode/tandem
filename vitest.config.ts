import { defineConfig } from "vitest/config";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One private state root for the whole run, chosen here (this config module is
// evaluated once, in the main Vitest process) so BOTH sides can reach it:
// test/global-state-dir.ts removes it on teardown via process.env, and every
// worker receives it through `test.env` below. See test/setup-hermetic-env.ts.
const stateRoot = join(tmpdir(), `tandem-test-state-${randomBytes(8).toString("hex")}`);
process.env.TANDEM_TEST_STATE_ROOT = stateRoot;

// An inline (empty) PostCSS config stops vite/vitest from walking UP past the
// repo for a postcss.config.js — a stray one in a parent directory (e.g.
// $HOME) would otherwise break every test run with unrelated plugin errors.
// This repo has no CSS to process.
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    // Clear ambient TANDEM_* and CCM_* config and redirect Tandem's private state
    // root (audit log, completion events, turn ledger, foreman inbox) into a
    // temp directory, so `npm test` behaves identically inside and outside a
    // running Tandem/Herdr worker and never appends to the real ~/.tandem.
    setupFiles: ["./test/setup-hermetic-env.ts"],
    // globalSetup owns the root's lifetime: setupFiles has no teardown hook
    // Vitest ever calls, which is how earlier runs leaked a directory per file.
    globalSetup: ["./test/global-state-dir.ts"],
    env: { TANDEM_TEST_STATE_ROOT: stateRoot },
    // Vitest's 5s default assumes no test file is saturating the machine.
    // test/claude-lifecycle-store-concurrency.test.ts deliberately spawns 150
    // real hook processes at once, and Vitest runs test FILES in parallel
    // workers, so its siblings can be starved of CPU for seconds at a time
    // through no fault of their own. Measured: with that file in the same run,
    // unrelated tests time out at 5s on the slower supported Node line while
    // passing in 236ms alone. None of them assert anything about duration, so
    // the fix is to stop the default from being the assertion.
    testTimeout: 30_000,
  },
});
