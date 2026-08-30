/**
 * state-dir.ts — the ONE resolver for Tandem's private state directory.
 *
 * Three modules had grown their own copy of "where does Tandem keep local
 * state": audit.ts and events.ts each hard-coded `join(homedir(), '.tandem')`,
 * while herdr-cursor-store.ts already honoured a `TANDEM_STATE_DIR` override.
 * That disagreement is why the events tests wrote into the developer's REAL
 * ~/.tandem/events.log — there was no seam to point them somewhere else.
 *
 * One resolver, honoured everywhere, gives every state consumer the same
 * override and makes "write nothing outside a temp dir" a property a test can
 * actually establish.
 *
 * TRUST MODEL: this directory holds terminal-derived content. It is created
 * 0700 and every file under it is written 0600; nothing here is ever returned
 * to an MCP caller as a path.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Tandem's private state root. `TANDEM_STATE_DIR` wins when set (the test and
 * multi-instance seam); otherwise `$HOME/.tandem`, falling back to the OS
 * user's home when HOME is unset.
 */
export function tandemStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TANDEM_STATE_DIR?.trim()
  if (configured) return resolve(configured)
  return resolve(join(env.HOME?.trim() || homedir(), '.tandem'))
}

/** A named subdirectory of the state root (e.g. 'turns', 'foreman'). */
export function tandemStatePath(...segments: string[]): string {
  return join(tandemStateDir(), ...segments)
}
