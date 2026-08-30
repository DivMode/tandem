/**
 * Vitest globalSetup: own the lifetime of the private state root the whole run
 * writes into, and sweep anything an earlier run abandoned.
 *
 * WHY globalSetup AND NOT setupFiles. `setupFiles` runs once per test FILE
 * inside a worker; nothing ever calls an exported `teardown` from it. An
 * earlier version of this harness exported one and relied on that, which
 * created a state directory per test file and removed none of them — measured
 * at ~320 abandoned `tandem-test-state-*` directories. globalSetup is the
 * mechanism Vitest actually invokes on both sides of a run, so cleanup here is
 * guaranteed rather than hoped for.
 *
 * The root itself is chosen in vitest.config.ts (evaluated once, in this same
 * main process) and handed to the workers through `test.env`, so every worker
 * writes under one directory that this file can remove in a single call.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'tandem-test-state-'
/** A run that crashed hard can still leave a root behind; reclaim old ones. */
const STALE_AFTER_MS = 60 * 60 * 1000

function sweepAbandonedRoots(keep: string): void {
  let entries: string[]
  try {
    entries = readdirSync(tmpdir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue
    const path = join(tmpdir(), entry)
    if (path === keep) continue
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_AFTER_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      /* raced with another run, or not ours to remove */
    }
  }
}

export function setup(): void {
  const root = process.env.TANDEM_TEST_STATE_ROOT
  if (!root) throw new Error('TANDEM_TEST_STATE_ROOT was not set by vitest.config.ts')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  sweepAbandonedRoots(root)
}

export function teardown(): void {
  const root = process.env.TANDEM_TEST_STATE_ROOT
  if (root) rmSync(root, { recursive: true, force: true })
}
