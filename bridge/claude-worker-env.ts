/**
 * claude-worker-env.ts — how a Tandem-spawned Claude worker gets a lifecycle
 * hook, and how it learns which Tandem session it is.
 *
 * PHASE 1 built the deposit half of the trusted-completion path: a store
 * (./claude-lifecycle-store.ts) and a `Stop`/`StopFailure` hook process
 * (./claude-stop-hook.ts) that writes into it. Neither can do anything unless
 * two things are true of the worker Claude actually runs in:
 *
 *   1. CLAUDE MUST BE TOLD TO RUN THE HOOK. Hook registration lives in a
 *      settings file. Tandem must NOT write into the user's own
 *      `~/.claude/settings.json` — that file is the user's, it is shared by
 *      every Claude they start by hand, and a bridge that edits it would be
 *      changing the behaviour of sessions it does not own. Instead the operator
 *      points `TANDEM_CLAUDE_SETTINGS_PATH` at a settings file of their own and
 *      Tandem passes it to the worker as `--settings <path>`, which layers on
 *      top of the personal settings for THAT process only. Unset is the normal
 *      case and changes nothing at all.
 *
 *   2. THE HOOK PROCESS MUST KNOW WHICH TANDEM SESSION IT BELONGS TO. It
 *      cannot work this out: a cwd is shared by every worker in a repository
 *      and a pid tree says nothing about Tandem's naming. So Tandem stamps
 *      `TANDEM_SESSION_ID` into the worker's environment at spawn and the hook
 *      copies it through (see claude-lifecycle-store.ts "IDENTITY IS SUPPLIED,
 *      NEVER INFERRED").
 *
 * WHY THE ID IS DERIVED RATHER THAN MINTED. The spawner and the reader are not
 * the same process: a bridge restart followed by a cold re-adoption has to be
 * able to match hook records to the session that produced them, with no memory
 * of the spawn. A random id would have to be persisted somewhere and kept in
 * step with adoption; a derived one is simply recomputed. It is a hash of the
 * installation's private state root and the session name, so it is stable
 * across restarts, distinct per installation, and OPAQUE — it carries no
 * project, path, or client text, which matters because this identity is one
 * step away from a surface an MCP client can read.
 *
 * It is a CORRELATION KEY, not a secret. Anything that could forge a record by
 * guessing it is already running as the same OS user, and could read the 0700
 * store directly. This is the same same-OS-user boundary ownership.ts states.
 *
 * VALIDATION IS FAIL-CLOSED, AND LOUD. A configured settings path that cannot
 * be trusted throws at spawn rather than being quietly dropped. Silently
 * ignoring it would leave the operator believing completion is reported by
 * Claude itself while it is in fact still being guessed from the terminal —
 * exactly the failure this whole path exists to remove.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { SESSION_ID_ENV } from './claude-lifecycle-store.ts'
import { tandemStateDir } from './state-dir.ts'

/** The operator-supplied settings file layered onto Tandem's Claude workers. */
export const CLAUDE_SETTINGS_PATH_ENV = 'TANDEM_CLAUDE_SETTINGS_PATH'

/** A settings file is small JSON; refuse to read anything that is not. */
const MAX_SETTINGS_BYTES = 256 * 1024

/** Raised when `TANDEM_CLAUDE_SETTINGS_PATH` is set to something untrustworthy. */
export class ClaudeSettingsError extends Error {
  constructor(message: string) {
    super(`${CLAUDE_SETTINGS_PATH_ENV}: ${message}`)
    this.name = 'ClaudeSettingsError'
  }
}

/** Everything Tandem adds to a Claude worker it spawns, or nothing at all. */
export interface ClaudeWorkerSpawn {
  /** Absolute, validated path passed as `--settings`. */
  settingsPath: string
  /** Opaque identity stamped into the worker as `TANDEM_SESSION_ID`. */
  sessionId: string
}

/**
 * The opaque Tandem identity for `name` on this installation.
 *
 * Derived, not stored: see "WHY THE ID IS DERIVED" above. `stateDir` is the
 * installation salt and is injectable for the same reason every other store
 * here takes one — so a test never depends on the developer's real ~/.tandem.
 */
export function tandemSessionIdFor(name: string, stateDir: string = tandemStateDir()): string {
  return `ts_${createHash('sha256').update(`${stateDir}\n${name}`).digest('hex').slice(0, 32)}`
}

/**
 * Validate a configured settings path, or throw explaining exactly why it was
 * refused.
 *
 * The checks mirror every other trusted file Tandem reads (see
 * claude-lifecycle-store.ts): a REGULAR file — never a symlink, whose target
 * can be repointed under us — owned by this uid, not writable by group or
 * other, within a sane size, and parseable as a JSON object. The write-mode
 * check is the load-bearing one: this file names commands Claude will execute,
 * so anything that lets another account rewrite it hands them a command in
 * every Tandem worker.
 */
export function validateClaudeSettingsPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) throw new ClaudeSettingsError('is set but empty')
  if (!isAbsolute(trimmed)) throw new ClaudeSettingsError(`must be an absolute path: ${trimmed}`)

  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(trimmed)
  } catch {
    throw new ClaudeSettingsError(`no such file: ${trimmed}`)
  }
  if (info.isSymbolicLink()) throw new ClaudeSettingsError(`must not be a symlink: ${trimmed}`)
  if (!info.isFile()) throw new ClaudeSettingsError(`is not a regular file: ${trimmed}`)
  if (info.size > MAX_SETTINGS_BYTES) throw new ClaudeSettingsError(`is larger than ${MAX_SETTINGS_BYTES} bytes: ${trimmed}`)
  if ((info.mode & 0o022) !== 0) throw new ClaudeSettingsError(`must not be group- or world-writable: ${trimmed}`)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new ClaudeSettingsError(`must be owned by this user: ${trimmed}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(trimmed, 'utf8'))
  } catch {
    throw new ClaudeSettingsError(`is not valid JSON: ${trimmed}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClaudeSettingsError(`must contain a JSON object: ${trimmed}`)
  }
  return trimmed
}

/**
 * What to add to a Claude spawn for `name`, or `undefined` when the host has
 * not configured a settings file.
 *
 * `undefined` is the whole of the "unconfigured" contract: no `--settings`
 * flag, no environment stamp, and therefore a spawn byte-identical to the one
 * before this phase existed.
 *
 * THROWS (ClaudeSettingsError) when the path IS configured but unusable.
 */
export function claudeWorkerSpawn(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = tandemStateDir(env),
): ClaudeWorkerSpawn | undefined {
  const configured = env[CLAUDE_SETTINGS_PATH_ENV]
  if (configured === undefined || configured.trim() === '') return undefined
  return { settingsPath: validateClaudeSettingsPath(configured), sessionId: tandemSessionIdFor(name, stateDir) }
}

/** The `claude` flags this adds, in a fixed order. Empty when unconfigured. */
export function claudeWorkerArgv(worker: ClaudeWorkerSpawn | undefined): string[] {
  return worker ? ['--settings', worker.settingsPath] : []
}

/** The environment this adds to the worker. Empty when unconfigured. */
export function claudeWorkerEnvironment(worker: ClaudeWorkerSpawn | undefined): Record<string, string> {
  return worker ? { [SESSION_ID_ENV]: worker.sessionId } : {}
}
