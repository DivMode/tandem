/**
 * Per-worker setup: make the test environment hermetic.
 *
 * TWO PROBLEMS, ONE PLACE TO FIX THEM.
 *
 * 1. AMBIENT CONFIG LEAKED IN. Tandem is often developed from inside a running
 *    Tandem/Herdr worker, whose environment already carries
 *    TANDEM_TERMINAL_BACKEND, TANDEM_CWD_ALLOWLIST, CCM_CWD_ALLOWLIST and
 *    friends. Baseline suites assert the fail-closed behaviour those variables
 *    switch off, so `npm test` failed from that shell and passed from a clean
 *    one — and the workaround was to prefix every invocation with a long
 *    `env -u ...` list. The suite now clears them itself, so `npm test` means
 *    the same thing wherever it runs.
 *
 * 2. STATE HAD NOWHERE SAFE TO GO. Tandem writes an audit log, a completion
 *    event log, the turn ledger and the foreman inbox under its state root,
 *    which defaults to the developer's real ~/.tandem.
 *
 * WHAT IS CLEARED: every TANDEM_* and CCM_* variable, with the single
 * exception of TANDEM_STATE_DIR, which this file then points at a private
 * per-worker directory. Tandem reads no bare HERDR_* variable (only
 * TANDEM_HERDR_*), so a Herdr worker's own environment needs no special case.
 *
 * WHAT IS NOT AFFECTED: a test that wants one of these values still sets it
 * itself, at call time or through a `withEnv` helper. This only removes what
 * the surrounding shell happened to be carrying; it never removes a value a
 * test deliberately set. Production runtime behaviour is untouched — nothing
 * here is imported outside the test harness.
 *
 * Ordering matters: setupFiles run BEFORE the test module's imports, so this
 * lands before router.ts builds its cwd allowlist at module load.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** The one variable this harness sets rather than clears. */
const STATE_DIR = 'TANDEM_STATE_DIR'
const ROOT_HANDOFF = 'TANDEM_TEST_STATE_ROOT'

/** Read the shared root before the sweep below can remove the handoff var. */
const sharedRoot = process.env[ROOT_HANDOFF]

export const clearedVariables: string[] = []
for (const key of Object.keys(process.env)) {
  if (key === STATE_DIR) continue
  if (!key.startsWith('TANDEM_') && !key.startsWith('CCM_')) continue
  clearedVariables.push(key)
  delete process.env[key]
}

// One state directory per worker process, all under the run-scoped root that
// test/global-state-dir.ts removes when the run ends.
const workerRoot = sharedRoot
  ? join(sharedRoot, `worker-${process.pid}`)
  : join(process.cwd(), 'node_modules', '.tmp', `tandem-test-state-${process.pid}`)
mkdirSync(workerRoot, { recursive: true, mode: 0o700 })
process.env[STATE_DIR] = workerRoot
