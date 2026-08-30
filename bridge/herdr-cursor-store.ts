/**
 * Durable read-cursor state for an owned Herdr session.
 *
 * WHY THIS EXISTS: the Herdr backend's cursor is Tandem's own counter (Herdr's
 * `read.revision` is 0 on every agent read), and its de-duplication needs the
 * previous read window. Both lived only in the bridge process, so a bridge
 * restart followed by a cold re-adoption reset them: a caller that came back
 * holding cursor 5 was answered with cursor 1 (live-measured: cursor 2 in,
 * cursor 1 out), and the first read after the restart re-delivered the whole
 * screen the caller had already consumed. Persisting the cursor, the last
 * window, and a bounded slice of already-emitted output makes a restart
 * invisible to a polling caller: cursors keep climbing, consumed output stays
 * consumed, and output produced while the bridge was down is still there to
 * collect.
 *
 * TRUST MODEL: same as ownership.ts — this is a same-OS-user boundary. State
 * lives under Tandem's private state directory (0700) in owner-only files
 * (0600), written atomically via rename, and is REJECTED rather than trusted
 * when anything about it is off: wrong owner, loose permissions, a symlink,
 * oversized, unparseable, wrong version, stale, or belonging to a different
 * Herdr workspace/terminal than the one being adopted. Rejection always
 * degrades to "no prior state", never to an error.
 *
 * These files contain terminal output, so they are never logged, never
 * returned to a caller as a path, and never written outside the private state
 * directory.
 */
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

const STATE_VERSION = 1
const DIRECTORY = 'herdr-sessions'
/** A key is derived from the session name by the caller; keep it path-safe. */
const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/
/** Refuse to even parse anything larger — bounded retention is enforced on write. */
const MAX_STATE_BYTES = 1024 * 1024
/** Replay history kept across restarts. */
const MAX_REPLAY_CHARS = 256 * 1024
const MAX_CHUNKS = 200
/** Window lines kept for read-to-read de-duplication. */
const MAX_WINDOW_LINES = 600
/** State older than this is discarded (and swept) rather than trusted. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Identifies the exact Herdr agent the state belongs to. */
export interface HerdrSessionIdentity {
  workspaceId: string
  terminalId: string
}

export interface HerdrCursorState {
  cursor: number
  window: string[]
  chunks: Array<{ cursor: number; text: string }>
  identity: HerdrSessionIdentity
}

export interface HerdrCursorStore {
  /** Prior state for `key`, or undefined when there is none to trust. */
  load(key: string, identity: HerdrSessionIdentity): Promise<HerdrCursorState | undefined>
  /** Persist `state`, refusing to rewind a durable cursor another process advanced. */
  save(key: string, state: HerdrCursorState): Promise<void>
  /** Forget `key` entirely (the session it described is gone). */
  clear(key: string): Promise<void>
}

export function defaultCursorStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.TANDEM_STATE_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.tandem')
  return join(resolve(stateDir), DIRECTORY)
}

/** Trim history to the retention bounds. Keeps the NEWEST chunks. */
export function boundState(state: HerdrCursorState): HerdrCursorState {
  const chunks = state.chunks.slice(-MAX_CHUNKS)
  let total = chunks.reduce((sum, chunk) => sum + chunk.text.length + 1, 0)
  while (chunks.length > 1 && total > MAX_REPLAY_CHARS) {
    total -= chunks[0].text.length + 1
    chunks.shift()
  }
  return { ...state, chunks, window: state.window.slice(-MAX_WINDOW_LINES) }
}

function isState(value: unknown, identity: HerdrSessionIdentity): value is HerdrCursorState & { version: number; updatedAt: number } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  if (candidate.version !== STATE_VERSION) return false
  if (typeof candidate.cursor !== 'number' || !Number.isSafeInteger(candidate.cursor) || candidate.cursor < 0) return false
  if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return false
  if (Date.now() - candidate.updatedAt > MAX_AGE_MS) return false
  if (!Array.isArray(candidate.window) || candidate.window.some((line) => typeof line !== 'string')) return false
  if (!Array.isArray(candidate.chunks)) return false
  for (const chunk of candidate.chunks) {
    if (!chunk || typeof chunk !== 'object') return false
    const entry = chunk as Record<string, unknown>
    if (typeof entry.cursor !== 'number' || !Number.isSafeInteger(entry.cursor)) return false
    if (typeof entry.text !== 'string') return false
    if (entry.cursor > candidate.cursor) return false
  }
  const stored = candidate.identity as Record<string, unknown> | undefined
  if (!stored || typeof stored !== 'object') return false
  // State belongs to ONE agent. A session re-created under the same name is a
  // different agent, and inheriting the old transcript would report output the
  // new agent never produced.
  return stored.workspaceId === identity.workspaceId && stored.terminalId === identity.terminalId
}

/** Owner-only files under Tandem's private state directory. */
export class FileHerdrCursorStore implements HerdrCursorStore {
  private readonly directory: string
  private swept = false

  constructor(directory: string = defaultCursorStateDir()) {
    this.directory = directory
  }

  private pathFor(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('invalid Herdr session state key')
    return join(this.directory, `${key}.json`)
  }

  /** Read the file only when it is a plain, owner-only, sanely sized file. */
  private async readTrusted(path: string): Promise<unknown> {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error('not a regular file')
    if (info.size > MAX_STATE_BYTES) throw new Error('state file too large')
    if ((info.mode & 0o077) !== 0) throw new Error('state file permissions are too broad')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error('state file has the wrong owner')
    }
    return JSON.parse(await readFile(path, 'utf8'))
  }

  async load(key: string, identity: HerdrSessionIdentity): Promise<HerdrCursorState | undefined> {
    void this.sweep()
    let parsed: unknown
    try {
      parsed = await this.readTrusted(this.pathFor(key))
    } catch {
      // Missing, corrupt, or untrustworthy: start clean rather than fail.
      return undefined
    }
    if (!isState(parsed, identity)) {
      // Stale, foreign, or from another agent — drop it so it cannot be
      // mistaken for this session's history later.
      await this.clear(key).catch(() => {})
      return undefined
    }
    return boundState({ cursor: parsed.cursor, window: parsed.window, chunks: parsed.chunks, identity })
  }

  async save(key: string, state: HerdrCursorState): Promise<void> {
    const path = this.pathFor(key)
    try {
      const existing = await this.readTrusted(path)
      // Never rewind a cursor another bridge process already advanced.
      if (isState(existing, state.identity) && existing.cursor > state.cursor) return
    } catch {
      // No usable prior file; writing a fresh one is correct.
    }
    const bounded = boundState(state)
    const payload = `${JSON.stringify({ version: STATE_VERSION, updatedAt: Date.now(), ...bounded })}\n`
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, payload, { mode: 0o600 })
    try {
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  async clear(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch(() => {})
  }

  /** Once per process: drop state files nothing will ever load again. */
  private async sweep(): Promise<void> {
    if (this.swept) return
    this.swept = true
    try {
      for (const entry of await readdir(this.directory)) {
        if (!entry.endsWith('.json') && !entry.endsWith('.tmp')) continue
        const path = join(this.directory, entry)
        const info = await lstat(path).catch(() => undefined)
        if (!info) continue
        if (Date.now() - info.mtimeMs > MAX_AGE_MS) await unlink(path).catch(() => {})
      }
    } catch {
      // No directory yet, or an unreadable one: nothing to sweep.
    }
  }
}

/** Process-local store for tests and for callers that want no persistence. */
export class MemoryHerdrCursorStore implements HerdrCursorStore {
  private readonly states = new Map<string, HerdrCursorState>()

  async load(key: string, identity: HerdrSessionIdentity): Promise<HerdrCursorState | undefined> {
    const state = this.states.get(key)
    if (!state) return undefined
    if (state.identity.workspaceId !== identity.workspaceId || state.identity.terminalId !== identity.terminalId) {
      this.states.delete(key)
      return undefined
    }
    return boundState(state)
  }

  async save(key: string, state: HerdrCursorState): Promise<void> {
    const existing = this.states.get(key)
    if (existing && existing.cursor > state.cursor) return
    this.states.set(key, boundState(state))
  }

  async clear(key: string): Promise<void> {
    this.states.delete(key)
  }
}
