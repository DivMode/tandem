/**
 * claude-lifecycle-store.ts — the durable record of what a Claude worker's OWN
 * process said it did, written by a Claude `Stop` / `StopFailure` hook.
 *
 * WHY THIS EXISTS. Every completion signal Tandem has today is INFERRED from
 * the outside: the bridge watches a terminal and decides, from idle detection
 * and screen content, that a turn probably ended. bridge/turn-ledger.ts makes
 * that inference reportable exactly once, but it cannot make it TRUE — a
 * repainting TUI, a slow tool call, or a worker that prints nothing all look
 * alike from the outside, and the failure modes are the expensive ones: a
 * completion announced for a turn still running, or a finished turn nobody
 * notices.
 *
 * A Claude lifecycle hook is a different KIND of signal. Claude runs it in its
 * own process at its own turn boundary and hands it structured JSON. It is not
 * a guess about a terminal; it is the engine stating that the turn ended, and
 * whether it ended cleanly (`Stop`) or in failure (`StopFailure`). This module
 * is where that statement is durably parked so a later reader — the router, in
 * a subsequent phase — can consume it.
 *
 * NOTHING HERE ROUTES, EMITS, OR DECIDES. This is a store and a read API. It
 * does not talk to bridge/events.ts, the foreman inbox, or the turn ledger, and
 * it never resolves a Tandem session name. Keeping the deposit path this small
 * is what lets the hook process be trivially safe (see ./claude-stop-hook.ts):
 * the hook validates, clamps, appends, and exits.
 *
 * IDENTITY IS SUPPLIED, NEVER INFERRED. The hook process is a child of the
 * Claude worker, so it cannot know which Tandem session it belongs to by
 * looking around — a cwd is shared by every worker in a repository and a pid
 * tree says nothing about Tandem's naming. Tandem therefore stamps an OPAQUE
 * identity into the worker's environment (`TANDEM_SESSION_ID`) when it spawns
 * it, and the hook copies it through. It is opaque on purpose: this store is a
 * step away from a surface an MCP client can read, and a human-meaningful name
 * would carry project and client information the store has no business
 * holding. An event with no identity is not recorded at all.
 *
 * WHAT IS DELIBERATELY NOT STORED. The Stop payload carries `cwd` and
 * `transcript_path`. Both are absolute local filesystem locations, and the
 * transcript path additionally names a file holding the ENTIRE conversation.
 * Neither is read, and neither is stored — not even redacted. The single
 * free-text field (`last_assistant_message`, on `Stop`) is clamped and passed
 * through the same sanitiser the foreman inbox uses, so credentials, URLs,
 * email addresses, tailnet identity and absolute paths are redacted before
 * anything reaches disk. See SECURITY.md.
 *
 * TRUST MODEL: mirrors bridge/foreman-inbox.ts and bridge/herdr-cursor-store.ts
 * — one owner-only file (0600) in a 0700 private directory, replaced atomically
 * via rename, and REJECTED rather than trusted when anything is off (not a
 * regular file, wrong owner, group/other-readable, oversized, unparseable,
 * wrong version). Rejection always degrades to "no prior state", never to an
 * error, because the alternative is a hook that fails and a Claude worker that
 * notices.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tandemStatePath } from './state-dir.ts'
import { sanitizeEventText } from './foreman-inbox.ts'

/** Bumped whenever the on-disk shape below changes; older state is discarded. */
export const CLAUDE_LIFECYCLE_VERSION = 1

const DIRECTORY = 'claude-lifecycle'
const FILENAME = 'events.json'

/** Retention bounds, enforced on every write so the file cannot grow without
 *  limit on a long-lived host. */
export const MAX_RETAINED_EVENTS = 200
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_STORE_BYTES = 1024 * 1024

/** The hard clamp on the one free-text field this store holds. */
export const MAX_MESSAGE_CHARS = 2000

/** Opaque identities: bounded, printable, single-line. Anything else is a bug
 *  or an attempt to smuggle structure through an id, and is refused. */
const MAX_IDENTITY_CHARS = 128
const IDENTITY_RE = /^[\x21-\x7e][\x20-\x7e]{0,127}$/

const DEFAULT_PAGE_LIMIT = 100

/** The environment variable Tandem stamps into a spawned Claude worker. */
export const SESSION_ID_ENV = 'TANDEM_SESSION_ID'

/**
 * The two turn boundaries Claude reports. They are kept distinct rather than
 * flattened to "done": a foreman acts differently on a turn that ended cleanly
 * and one that ended in failure, and collapsing them here would make that
 * distinction unrecoverable downstream.
 */
export type ClaudeLifecycleKind = 'stop' | 'stop_failure'

export interface ClaudeLifecycleEvent {
  v: number
  /** Unique per record. Derived from the identities and this event's own seq,
   *  so two genuinely distinct turns never collide into one id — Claude gives
   *  the hook no turn counter, and content-hashing would silently swallow a
   *  second identical turn. */
  id: string
  /** Monotonic per-store ordinal. The whole read API is built on it. */
  seq: number
  ts: string
  kind: ClaudeLifecycleKind
  /** Opaque Tandem session identity, from the worker's environment. */
  tandemSession: string
  /** Claude's own opaque session id, straight from the hook payload. */
  claudeSessionId: string
  /** Sanitised, clamped last assistant message (`Stop` only, when present). */
  message?: string
  /** The message was longer than the clamp and was cut. */
  messageTruncated?: boolean
}

/** What a caller supplies; every derived and safety-critical field is computed here. */
export interface ClaudeLifecycleInput {
  kind: ClaudeLifecycleKind
  tandemSession: string
  claudeSessionId: string
  message?: string
  /** Test seam only. */
  now?: Date
}

/** A snapshot of where the store is right now, taken before doing anything a
 *  later `readAfter` is meant to observe the effect of. */
export interface ClaudeLifecycleCursor {
  /** Highest seq issued so far; 0 when the store is empty. */
  seq: number
  /** Identifies THIS store. A change means the store was reset and a seq from
   *  the previous one is not comparable. */
  storeEpoch: string
}

export interface ClaudeLifecyclePage extends ClaudeLifecycleCursor {
  version: number
  events: ClaudeLifecycleEvent[]
  /** Retained events remain after this page; call again with the returned seq. */
  more: boolean
  /**
   * Events the caller never saw are GONE — retention dropped them, or the seq
   * came from a store that no longer exists. Never set merely because a page
   * was cut short by `limit`; that is `more`.
   */
  truncated: boolean
}

interface StoreFile {
  version: number
  /** Regenerated whenever the store is created fresh, so a seq issued by a
   *  previous store is detectable instead of silently misinterpreted. */
  epoch: string
  nextSeq: number
  /** Highest seq retention has dropped; anything at or below it is gone. */
  droppedThrough: number
  events: ClaudeLifecycleEvent[]
}

/**
 * The epoch used while nothing has been persisted yet. DETERMINISTIC on
 * purpose: a router that snapshots an empty store and comes back later must not
 * be told history was truncated when in fact it has simply seen nothing yet.
 */
const EMPTY_STORE_EPOCH = '0'

/** An opaque identity Tandem or Claude supplied: bounded, printable, one line. */
export function isOpaqueIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_IDENTITY_CHARS && IDENTITY_RE.test(value)
}

/** The Tandem session identity for this process, or undefined when absent or
 *  unusable. Absent is the normal case for a Claude the user started by hand. */
export function tandemSessionIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[SESSION_ID_ENV]?.trim()
  return raw && isOpaqueIdentity(raw) ? raw : undefined
}

function isEvent(value: unknown): value is ClaudeLifecycleEvent {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    c.v === CLAUDE_LIFECYCLE_VERSION &&
    typeof c.id === 'string' &&
    typeof c.seq === 'number' &&
    Number.isSafeInteger(c.seq) &&
    c.seq > 0 &&
    typeof c.ts === 'string' &&
    (c.kind === 'stop' || c.kind === 'stop_failure') &&
    isOpaqueIdentity(c.tandemSession) &&
    isOpaqueIdentity(c.claudeSessionId) &&
    (c.message === undefined || typeof c.message === 'string')
  )
}

function isStoreFile(value: unknown): value is StoreFile {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    c.version === CLAUDE_LIFECYCLE_VERSION &&
    typeof c.epoch === 'string' &&
    c.epoch.length > 0 &&
    typeof c.nextSeq === 'number' &&
    Number.isSafeInteger(c.nextSeq) &&
    c.nextSeq > 0 &&
    typeof c.droppedThrough === 'number' &&
    Number.isSafeInteger(c.droppedThrough) &&
    c.droppedThrough >= 0 &&
    Array.isArray(c.events)
  )
}

/**
 * The durable Claude lifecycle store.
 *
 * `directory` is injectable so tests — and a host running two Tandem instances
 * — never touch real home state.
 */
export class ClaudeLifecycleStore {
  private readonly directory: string

  constructor(directory: string = tandemStatePath(DIRECTORY)) {
    this.directory = directory
  }

  private get path(): string {
    return join(this.directory, FILENAME)
  }

  private static fresh(): StoreFile {
    return {
      version: CLAUDE_LIFECYCLE_VERSION,
      epoch: EMPTY_STORE_EPOCH,
      nextSeq: 1,
      droppedThrough: 0,
      events: [],
    }
  }

  /**
   * Read the store, refusing anything that is not demonstrably ours: a regular
   * file, owned by this uid, readable by nobody else, within the size bound,
   * parseable, and of the current version. Every refusal degrades to an empty
   * store — a hook that threw here would be a hook that broke Claude.
   */
  private load(): StoreFile {
    try {
      const info = lstatSync(this.path)
      if (!info.isFile()) return ClaudeLifecycleStore.fresh()
      if (info.size > MAX_STORE_BYTES) return ClaudeLifecycleStore.fresh()
      if ((info.mode & 0o077) !== 0) return ClaudeLifecycleStore.fresh()
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return ClaudeLifecycleStore.fresh()
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!isStoreFile(parsed)) return ClaudeLifecycleStore.fresh()
      // Drop individually malformed records rather than the whole store.
      return { ...parsed, events: parsed.events.filter(isEvent) }
    } catch {
      return ClaudeLifecycleStore.fresh()
    }
  }

  /** Write via a temp file and rename, so a concurrent reader sees either the
   *  whole previous store or the whole new one and never a partial write. */
  private persist(store: StoreFile): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 })
    try {
      renameSync(temporary, this.path)
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* already gone */
      }
      throw error
    }
  }

  /** Enforce the retention bounds, recording how far history was dropped so a
   *  reader can be told its seq no longer covers everything. */
  private applyRetention(store: StoreFile, now: number): StoreFile {
    let events = store.events.filter((e) => {
      const age = now - Date.parse(e.ts)
      return !Number.isFinite(age) || age <= MAX_EVENT_AGE_MS
    })
    if (events.length > MAX_RETAINED_EVENTS) events = events.slice(events.length - MAX_RETAINED_EVENTS)
    // Byte bound as a backstop against unexpectedly large records.
    while (events.length > 1 && Buffer.byteLength(JSON.stringify(events), 'utf8') > MAX_STORE_BYTES) {
      events.shift()
    }
    const oldestKept = events.length > 0 ? events[0]!.seq : store.nextSeq
    const droppedThrough = Math.max(store.droppedThrough, oldestKept - 1)
    return { ...store, events, droppedThrough }
  }

  /**
   * Record one Claude turn boundary. Returns the stored event, or `undefined`
   * when the input was unusable or the store could not be written.
   *
   * NEVER THROWS. This runs inside a hook process Claude is waiting on; an
   * exception here would surface to the user as a broken worker, which is a
   * strictly worse outcome than a lost reporting record.
   */
  record(input: ClaudeLifecycleInput): ClaudeLifecycleEvent | undefined {
    try {
      if (input.kind !== 'stop' && input.kind !== 'stop_failure') return undefined
      if (!isOpaqueIdentity(input.tandemSession)) return undefined
      if (!isOpaqueIdentity(input.claudeSessionId)) return undefined

      const loaded = this.load()
      // Mint the real store epoch on the first persisted write; until then the
      // store carries the deterministic empty-store epoch (see above).
      const store = loaded.epoch === EMPTY_STORE_EPOCH ? { ...loaded, epoch: randomBytes(8).toString('hex') } : loaded

      const seq = store.nextSeq
      const now = input.now ?? new Date()
      const id =
        'cl_' +
        createHash('sha256')
          .update([store.epoch, input.tandemSession, input.claudeSessionId, input.kind, String(seq)].join(' '))
          .digest('hex')
          .slice(0, 20)

      const raw = typeof input.message === 'string' ? input.message : undefined
      const message = raw ? sanitizeEventText(raw, MAX_MESSAGE_CHARS) : undefined
      // "Truncated" is about the CLAMP, not about redaction: the sanitiser also
      // shortens text by replacing secrets, and calling that truncation would
      // mislead a reader into thinking the tail was lost.
      const messageTruncated = raw !== undefined && raw.length > MAX_MESSAGE_CHARS

      const event: ClaudeLifecycleEvent = {
        v: CLAUDE_LIFECYCLE_VERSION,
        id,
        seq,
        ts: now.toISOString(),
        kind: input.kind,
        tandemSession: input.tandemSession,
        claudeSessionId: input.claudeSessionId,
        ...(message ? { message } : {}),
        ...(messageTruncated ? { messageTruncated: true } : {}),
      }

      this.persist(
        this.applyRetention({ ...store, nextSeq: seq + 1, events: [...store.events, event] }, now.getTime()),
      )
      return event
    } catch {
      return undefined
    }
  }

  /**
   * Where the store is right now. A caller takes this BEFORE the work it wants
   * to observe the effect of, then passes `seq` to readAfter.
   *
   * Never throws: an unreadable store reports an empty one.
   */
  snapshot(): ClaudeLifecycleCursor {
    const store = this.load()
    const highest = store.events.length > 0 ? store.events[store.events.length - 1]!.seq : store.nextSeq - 1
    return { seq: Math.max(0, highest), storeEpoch: store.epoch }
  }

  /**
   * Every retained event newer than `seq`, oldest first.
   *
   * `storeEpoch` lets the caller detect a reset store: pass the epoch that came
   * with the seq and a mismatch is reported as `truncated`, because a seq
   * minted by a store that no longer exists says nothing about this one.
   *
   * Never throws.
   */
  readAfter(seq: number, opts: { limit?: number; storeEpoch?: string } = {}): ClaudeLifecyclePage {
    const store = this.load()
    const after = Number.isSafeInteger(seq) && seq > 0 ? seq : 0
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_RETAINED_EVENTS))

    const epochChanged =
      opts.storeEpoch !== undefined && opts.storeEpoch !== EMPTY_STORE_EPOCH && opts.storeEpoch !== store.epoch
    const newer = store.events.filter((e) => e.seq > after).sort((a, b) => a.seq - b.seq)
    const events = newer.slice(0, limit)
    const highest = events.length > 0 ? events[events.length - 1]!.seq : Math.max(after, store.droppedThrough)

    return {
      version: CLAUDE_LIFECYCLE_VERSION,
      events,
      seq: highest,
      storeEpoch: store.epoch,
      more: newer.length > events.length,
      // Only a genuine gap counts: the caller asked for everything after a seq
      // that retention has already dropped past, or the store was replaced.
      truncated: epochChanged || after < store.droppedThrough,
    }
  }
}

/** Process-wide store, memoized per resolved directory so a changed
 *  TANDEM_STATE_DIR (tests, multi-instance hosts) yields its own store. */
const stores = new Map<string, ClaudeLifecycleStore>()
export function defaultClaudeLifecycleStore(): ClaudeLifecycleStore {
  const directory = tandemStatePath(DIRECTORY)
  let store = stores.get(directory)
  if (!store) {
    store = new ClaudeLifecycleStore(directory)
    stores.set(directory, store)
  }
  return store
}
