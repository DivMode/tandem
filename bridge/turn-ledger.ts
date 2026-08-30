/**
 * turn-ledger.ts — durable per-session TURN state, and the single place that
 * decides whether a finished turn has already been reported.
 *
 * WHY THIS EXISTS (the bug it fixes). Completion events used to be emitted from
 * the READ path on a content test:
 *
 *     if (page.idle && page.text.trim().length > 0) emitCompletion(...)
 *
 * That is not a lifecycle boundary, it is an observation. Two consequences,
 * both reproducible:
 *
 *   1. DUPLICATES ON REPEATED POLLS. `read({cursor})` returns everything newer
 *      than `cursor`. A foreman that polls twice with the SAME (stale) cursor —
 *      the documented recovery move after an interruption — gets the same text
 *      twice and manufactured two completion events for one turn. The same
 *      happened for send()-returns-done followed by one confirming poll.
 *   2. NOTHING SURVIVED A RESTART. The "is a turn in flight" fact lived only in
 *      the bridge process, so a restart followed by a cold re-adoption could
 *      re-emit a completion for a turn already reported.
 *
 * The fix is to emit on a TRANSITION rather than on an observation: a turn is
 * opened by send(), and exactly one completion is emitted the first time that
 * open turn is observed finished — whether that observation arrives on the
 * send() call itself or on a later poll. This ledger holds that state durably.
 *
 * IDENTITY AND EPOCH (why ids cannot collide across incarnations). A session
 * name is reusable: close `review` and open `review` again and it is a
 * different agent with a different history. Each backend supplies a stable
 * per-incarnation identity (Herdr: workspace + terminal id; tmux: the tmux
 * session id + creation time). A changed identity bumps `epoch`, and `turnSeq`
 * is monotonic for the life of the entry and never reset — so an event id
 * derived from (device, name, epoch, turnSeq, kind) is unique across
 * close/reopen cycles even if the epoch counter itself were ever lost.
 *
 * Cursors are deliberately NOT part of any of this. A cursor is a byte offset
 * under tmux and Tandem's own synthetic counter under Herdr; the two are not
 * comparable, and neither is a turn identity.
 *
 * SYNCHRONOUS ON PURPOSE. Two concurrent polls of one session must not both
 * observe the same pending turn. Sync reads/writes make claim-and-clear atomic
 * with respect to other JavaScript in this process, which an async
 * read-modify-write could not promise. The files are a few hundred bytes and
 * are touched only at turn boundaries.
 *
 * BEST-EFFORT DURABILITY, NEVER A BROKEN SESSION. If the state directory
 * cannot be written — a read-only filesystem, a full disk, a test that stubs
 * node:fs — the ledger falls back to an in-process map instead of throwing.
 * That ordering is deliberate: this is a REPORTING mechanism, and taking down
 * the session it was reporting on would be far worse than losing durability.
 * The fallback still de-duplicates repeated polls within the process (the case
 * that actually caused duplicates); only cross-restart de-duplication is lost,
 * and only while the filesystem is unavailable.
 *
 * TRUST MODEL: mirrors herdr-cursor-store.ts — owner-only files (0600) in a
 * 0700 private directory, written atomically via rename, and REJECTED rather
 * than trusted when anything is off (wrong owner, loose permissions, not a
 * regular file, oversized, unparseable, wrong version, stale). Rejection always
 * degrades to "no prior state", never to an error. A ledger entry holds no
 * terminal output — only counters and an opaque identity string.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isClaudeTurnBaseline, type ClaudeTurnBaseline } from './claude-completion.ts'
import { tandemStatePath } from './state-dir.ts'

/** Bumped whenever the on-disk shape below changes; older state is discarded. */
export const TURN_STATE_VERSION = 1

const DIRECTORY = 'turns'
/** Refuse to parse anything larger; entries are a few hundred bytes. */
const MAX_STATE_BYTES = 64 * 1024
/** Entries older than this are swept — long after any event referencing them
 *  has rotated out of the foreman inbox. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** A stable coordinate for one turn of one incarnation of one session. */
export interface TurnRef {
  /** Opaque per-incarnation agent identity, as reported by the backend. */
  identity: string
  /** Increments each time the identity behind this name changes. */
  epoch: number
  /** Monotonic turn counter for this name. Never reset. */
  turnSeq: number
}

interface TurnState extends TurnRef {
  version: number
  /** The turn opened by send() and not yet reported, if any. */
  pendingTurn: number | null
  /**
   * Where the Claude lifecycle store stood when `pendingTurn` was opened, for
   * engines that report their own turn boundary (see claude-completion.ts).
   * Parked HERE rather than in the bridge process because the whole point is
   * that it survives a restart and a cold re-adoption: without it, a foreman
   * coming back to a session cannot tell this turn's `Stop` from the previous
   * turn's, and the previous turn's is still sitting in the store.
   *
   * Cleared wherever `pendingTurn` is: a baseline outliving its turn would let
   * a boundary Claude reported for a turn that was interrupted, superseded, or
   * already reported end a turn it has nothing to do with. Absent on entries
   * written before this field existed, and on every non-Claude engine.
   */
  lifecycle?: ClaudeTurnBaseline | null
  /** Highest turn already reported as completed. */
  lastEmittedTurn: number
  updatedAt: number
}

function isTurnState(value: unknown): value is TurnState {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  if (c.version !== TURN_STATE_VERSION) return false
  if (typeof c.identity !== 'string') return false
  if (typeof c.epoch !== 'number' || !Number.isSafeInteger(c.epoch) || c.epoch < 0) return false
  if (typeof c.turnSeq !== 'number' || !Number.isSafeInteger(c.turnSeq) || c.turnSeq < 0) return false
  if (typeof c.lastEmittedTurn !== 'number' || !Number.isSafeInteger(c.lastEmittedTurn)) return false
  if (c.pendingTurn !== null && (typeof c.pendingTurn !== 'number' || !Number.isSafeInteger(c.pendingTurn))) return false
  if (typeof c.updatedAt !== 'number' || !Number.isFinite(c.updatedAt)) return false
  if (Date.now() - c.updatedAt > MAX_AGE_MS) return false
  // Absent is legitimate (an older entry, or a non-Claude engine); present but
  // malformed is not, and a half-read baseline must never be treated as one.
  if (c.lifecycle !== undefined && c.lifecycle !== null && !isClaudeTurnBaseline(c.lifecycle)) return false
  return true
}

/**
 * Durable turn state for every Tandem-driven session on this host.
 *
 * `directory` is injectable so tests never touch real home state.
 */
export class TurnLedger {
  private readonly directory: string
  private swept = false
  /** Fallback when the state directory is unwritable; also shadows a stale file
   *  if a write failed after an earlier one succeeded. */
  private readonly memory = new Map<string, TurnState>()

  constructor(directory: string = tandemStatePath(DIRECTORY)) {
    this.directory = directory
  }

  /** Filenames are a hash of the session name: no caller-controlled path text
   *  ever reaches the filesystem, whatever a future name rule allows. */
  private pathFor(name: string): string {
    return join(this.directory, `${createHash('sha256').update(name).digest('hex').slice(0, 32)}.json`)
  }

  /**
   * The state for `name`. Disk is authoritative unless the in-memory copy is
   * newer, which happens exactly when a durable write failed and the file on
   * disk is stale — trusting it then would resurrect an already-reported turn.
   */
  private read(name: string): TurnState | undefined {
    const onDisk = this.readFile(name)
    const inMemory = this.memory.get(name)
    if (onDisk && inMemory) return inMemory.updatedAt >= onDisk.updatedAt ? inMemory : onDisk
    return inMemory ?? onDisk
  }

  private readFile(name: string): TurnState | undefined {
    const path = this.pathFor(name)
    try {
      const info = lstatSync(path)
      if (!info.isFile()) return undefined
      if (info.size > MAX_STATE_BYTES) return undefined
      if ((info.mode & 0o077) !== 0) return undefined
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return undefined
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return isTurnState(parsed) ? parsed : undefined
    } catch {
      // Missing, corrupt, or untrustworthy: start clean rather than fail.
      return undefined
    }
  }

  /** Record in memory first (so the turn is never lost), then try to persist. */
  private write(name: string, state: TurnState): void {
    this.memory.set(name, state)
    try {
      this.writeFile(name, state)
    } catch {
      // Unwritable state directory: keep going on the in-memory copy rather
      // than failing the send/poll this ledger only exists to report on.
      process.stderr.write('[turn-ledger] durable turn state unavailable; de-duplicating in memory only\n')
    }
  }

  private writeFile(name: string, state: TurnState): void {
    const path = this.pathFor(name)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    try {
      renameSync(temporary, path)
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* the temp file is already gone */
      }
      throw error
    }
  }

  /**
   * Load the entry for `name`, reconciling it against the identity the backend
   * reports right now. A changed identity means this name is a DIFFERENT agent:
   * the epoch advances and any turn the previous incarnation left pending is
   * dropped (it can never complete now).
   */
  private reconcile(name: string, identity: string): TurnState {
    this.sweep()
    const existing = this.read(name)
    if (!existing) {
      return { version: TURN_STATE_VERSION, identity, epoch: 1, turnSeq: 0, pendingTurn: null, lifecycle: null, lastEmittedTurn: 0, updatedAt: Date.now() }
    }
    if (existing.identity !== identity) {
      return { ...existing, identity, epoch: existing.epoch + 1, pendingTurn: null, lifecycle: null, updatedAt: Date.now() }
    }
    return existing
  }

  private save(name: string, state: TurnState): TurnRef {
    const next = { ...state, updatedAt: Date.now() }
    this.write(name, next)
    return { identity: next.identity, epoch: next.epoch, turnSeq: next.turnSeq }
  }

  /**
   * Open a turn: send() has just delivered an instruction. Returns the
   * coordinate of the turn now in flight, and — when a previous turn was still
   * outstanding — the coordinate of the turn this one SUPERSEDED.
   *
   * A second send while a turn is in flight is a real event a foreman needs to
   * see. The engine receives the new instruction into the same session, so the
   * first turn will never report a completion of its own; without this it
   * simply vanished from the record, and a foreman reading the feed would
   * still be waiting on it.
   */
  beginTurn(
    name: string,
    identity: string,
    lifecycle?: ClaudeTurnBaseline,
  ): { turn: TurnRef; superseded?: TurnRef } {
    const state = this.reconcile(name, identity)
    const superseded =
      state.pendingTurn === null
        ? undefined
        : { identity: state.identity, epoch: state.epoch, turnSeq: state.pendingTurn }
    const turnSeq = state.turnSeq + 1
    // A superseding send REPLACES the baseline rather than inheriting it: the
    // turn it belonged to has just been reported as interrupted, and letting
    // its baseline stand would offer the new turn a boundary the old one owned.
    const turn = this.save(name, { ...state, turnSeq, pendingTurn: turnSeq, lifecycle: lifecycle ?? null })
    return superseded ? { turn, superseded } : { turn }
  }

  /**
   * The lifecycle baseline of the turn currently in flight, or undefined when
   * there is no such turn, the entry belongs to a different incarnation, or the
   * turn was opened without one.
   *
   * READ-ONLY on purpose: a poll asking "did Claude report a boundary?" must
   * not itself advance any state. The claim that follows is made through
   * completeTurn/abortTurn, which is where exactly-once lives.
   */
  pendingBaseline(name: string, identity: string): ClaudeTurnBaseline | undefined {
    const state = this.read(name)
    if (!state || state.identity !== identity) return undefined
    if (state.pendingTurn === null) return undefined
    return state.lifecycle ?? undefined
  }

  /**
   * Claim the completion of the turn in flight. Returns its coordinate the
   * FIRST time it is observed finished and `undefined` on every later
   * observation — this is the whole duplicate-suppression mechanism, and it is
   * durable, so it holds across a bridge restart and a cold re-adoption too.
   *
   * `undefined` is also the correct answer when there is no turn in flight: a
   * session sitting idle because a human typed into the TUI directly is not a
   * turn Tandem drove, and Tandem does not report it as one.
   */
  completeTurn(name: string, identity: string): TurnRef | undefined {
    const state = this.reconcile(name, identity)
    const pending = state.pendingTurn
    if (pending === null) {
      // Still persist an identity/epoch change we just discovered.
      if (this.read(name)?.epoch !== state.epoch) this.save(name, state)
      return undefined
    }
    return this.save(name, {
      ...state,
      turnSeq: Math.max(state.turnSeq, pending),
      pendingTurn: null,
      lifecycle: null,
      lastEmittedTurn: pending,
    })
  }

  /**
   * End the turn in flight WITHOUT completing it (interrupt, or a send that
   * threw). Returns its coordinate once, then `undefined`, exactly like
   * completeTurn.
   */
  abortTurn(name: string, identity: string): TurnRef | undefined {
    const state = this.reconcile(name, identity)
    const pending = state.pendingTurn
    if (pending === null) return undefined
    return this.save(name, { ...state, pendingTurn: null, lifecycle: null })
  }

  /**
   * A session-level coordinate that is not tied to a turn (used by `closed`).
   * Advances `turnSeq` so the event it labels is distinct from every turn event
   * on the same session, and the entry is KEPT after a close so a session
   * reopened under the same name cannot reuse an earlier incarnation's ids.
   */
  sessionRef(name: string, identity: string): TurnRef {
    const state = this.reconcile(name, identity)
    return this.save(name, { ...state, turnSeq: state.turnSeq + 1, pendingTurn: null, lifecycle: null })
  }

  /** Current state without changing anything (tests and diagnostics). */
  inspect(
    name: string,
  ): (TurnRef & { pendingTurn: number | null; lastEmittedTurn: number; lifecycle?: ClaudeTurnBaseline }) | undefined {
    const s = this.read(name)
    return (
      s && {
        identity: s.identity,
        epoch: s.epoch,
        turnSeq: s.turnSeq,
        pendingTurn: s.pendingTurn,
        lastEmittedTurn: s.lastEmittedTurn,
        ...(s.lifecycle ? { lifecycle: s.lifecycle } : {}),
      }
    )
  }

  /** Once per process: drop entries nothing will ever consult again. */
  private sweep(): void {
    if (this.swept) return
    this.swept = true
    try {
      for (const entry of readdirSync(this.directory)) {
        if (!entry.endsWith('.json') && !entry.endsWith('.tmp')) continue
        const path = join(this.directory, entry)
        try {
          if (Date.now() - lstatSync(path).mtimeMs > MAX_AGE_MS) rmSync(path, { force: true })
        } catch {
          /* raced with another sweep */
        }
      }
    } catch {
      // No directory yet, or an unreadable one: nothing to sweep.
    }
  }
}

/** Process-wide ledger, memoized per resolved directory so a changed
 *  TANDEM_STATE_DIR (tests, multi-instance hosts) yields its own ledger. */
const ledgers = new Map<string, TurnLedger>()
export function defaultTurnLedger(): TurnLedger {
  const directory = tandemStatePath(DIRECTORY)
  let ledger = ledgers.get(directory)
  if (!ledger) {
    ledger = new TurnLedger(directory)
    ledgers.set(directory, ledger)
  }
  return ledger
}
