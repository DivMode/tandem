/**
 * Global test setup: give every suite its own private Tandem state root.
 *
 * Tandem writes an audit log, a completion-event log, the turn ledger, and the
 * foreman event store under its state directory. Before this file existed the
 * default was the developer's real ~/.tandem, so running the suite appended to
 * real home state — and individual suites worked around it by stubbing
 * node:fs's appendFileSync/mkdirSync, which silently disabled writes rather
 * than redirecting them.
 *
 * Every state consumer now resolves through bridge/state-dir.ts on each write,
 * so one environment variable redirects all of it. Individual tests may still
 * override TANDEM_STATE_DIR with their own temp directory; this is only the
 * floor that guarantees nothing lands in a real home.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'tandem-test-state-'))
process.env.TANDEM_STATE_DIR = root

export function teardown(): void {
  rmSync(root, { recursive: true, force: true })
}
