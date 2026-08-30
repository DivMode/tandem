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
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY SQLITE, AND WHY THERE IS NO LOCK OF OUR OWN
 *
 * `record()` is a compute-next-seq -> persist transaction, and every
 * Tandem-spawned Claude worker's hook is a SEPARATE OS process writing into
 * this ONE shared store. The first cut of this module was a single JSON file
 * replaced by atomic rename. Atomic rename only prevents a TORN write; it does
 * nothing about two processes both reading the same on-disk state and each
 * computing their own "next event" against it — whichever rename lands last
 * silently discards the other's record. Measured: 150 concurrent hook
 * processes writing one record each -> roughly 32 survived.
 *
 * That was then patched with a hand-rolled `mkdirSync` lock plus mtime-based
 * stale-lock recovery. It worked, but it is a probabilistic correctness
 * argument resting on a wall-clock heuristic: "a lock older than N ms must
 * belong to a crashed process". A writer that is merely slow — a loaded host,
 * a stopped process, a filesystem stall — is indistinguishable from a dead
 * one, and clearing its lock puts two writers back inside the same critical
 * section, which is exactly the lost update the lock existed to prevent.
 *
 * Node ships SQLite (`node:sqlite`). Multi-process serialisation of this
 * shape of transaction is what SQLite is for, and it does it with a real lock
 * protocol in the file rather than a timeout guess: `BEGIN IMMEDIATE` takes
 * the write lock up front, a bounded `busy_timeout` waits for it, and a
 * crashed writer leaves a hot journal that the NEXT opener rolls back
 * deterministically — no staleness heuristic anywhere. So there is no custom
 * lock here, and there must never be one again: a filesystem lock wrapped
 * around SQLite would reintroduce the guess it was brought in to remove.
 *
 * ROLLBACK JOURNAL, NOT WAL. Measured on this workload (a burst of
 * short-lived, one-transaction processes) through the real hook entrypoint:
 * 150 concurrent hook processes -> 150/150 recorded, seqs 1..150 with no gaps,
 * on every supported Node line. Slowest single transaction 644ms at 300-way
 * concurrency on the slowest supported Node, against the budget below. The
 * default rollback journal passes with wide margin, so it is what we use. WAL
 * would add a `-wal` and a `-shm` file whose lifecycle and permissions we
 * would then have to be right about, and buys nothing a workload this small
 * can measure.
 *
 * SEQUENCE IS DURABLE AND NEVER REUSED. `seq INTEGER PRIMARY KEY AUTOINCREMENT`
 * keeps its high-water mark in `sqlite_sequence`, which retention deletes do
 * not touch, so a seq issued once is never issued again for the life of the
 * database file. Retention runs inside the same transaction as the insert.
 *
 * TRUST MODEL: mirrors bridge/foreman-inbox.ts and bridge/herdr-cursor-store.ts
 * — one owner-only database (0600) in a 0700 private directory, and REJECTED
 * rather than trusted when anything is off (not a regular file, a symlink,
 * wrong owner, group/other-accessible, oversized, not a SQLite file, wrong
 * `user_version`). Rejection degrades to "no prior state" on the read path and
 * to "replace it" on the write path, never to an error, because the
 * alternative is a hook that fails and a Claude worker that notices.
 *
 * NEVER THROWS, NEVER HANGS. Every public method is total. The only unbounded
 * thing SQLite could do here is wait for a lock, and `busy_timeout` bounds
 * that; a write that cannot get in returns `undefined` exactly like every
 * other failure.
 *
 * NO MIGRATION FROM THE JSON STORE, DELIBERATELY. The JSON implementation only
 * ever existed on this unmerged branch, so there is no released version whose
 * `events.json` anyone could be upgrading from — a reader would be code that
 * can never run against real data. Retention would drop everything it imported
 * within seven days regardless. A stale `events.json` left in the state
 * directory by a developer who ran the earlier commit is inert: nothing reads
 * that name any more.
 */
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { tandemStatePath } from './state-dir.ts'
import { sanitizeEventText } from './foreman-inbox.ts'

/**
 * Bumped whenever the on-disk shape below changes; older state is discarded.
 * Held as SQLite's own `PRAGMA user_version`, which lives in the database
 * header rather than in a table — so a store written by a version whose SCHEMA
 * differs can still be recognised and replaced without first having to query a
 * table that may not have the columns this version expects.
 */
export const CLAUDE_LIFECYCLE_VERSION = 1

const DIRECTORY = 'claude-lifecycle'
const FILENAME = 'events.db'

/** Retention bounds, enforced in the same transaction as every write so the
 *  database cannot grow without limit on a long-lived host. */
export const MAX_RETAINED_EVENTS = 200
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A sanity bound on the file, not a retention mechanism — retention is the two
 * bounds above, and every row is bounded by construction (clamped message,
 * bounded identities), so 200 rows cannot approach this. A file past it is not
 * one this code produced, and is treated as foreign.
 */
const MAX_STORE_BYTES = 8 * 1024 * 1024

/** The hard clamp on the one free-text field this store holds. */
export const MAX_MESSAGE_CHARS = 2000

/** Opaque identities: bounded, printable, single-line. Anything else is a bug
 *  or an attempt to smuggle structure through an id, and is refused. */
const MAX_IDENTITY_CHARS = 128
const IDENTITY_RE = /^[\x21-\x7e][\x20-\x7e]{0,127}$/

const DEFAULT_PAGE_LIMIT = 100

/**
 * How long SQLite waits for the write lock before giving up, at which point
 * `record()` returns `undefined` like any other failure.
 *
 * The same 5000ms src/claude-stop-hook.ts already allows stdin, and for the
 * same reason: that is how long this hook is willing to make Claude wait
 * before giving up on a turn boundary. Losing the record is the expensive
 * outcome — it is the very failure this whole path exists to remove — so the
 * budget is set by what is tolerable to wait, not by what is typically
 * needed. A transaction here is one small insert plus two bounded deletes,
 * well under a millisecond of actual work; all of this is contention
 * headroom. Measured through the real entrypoint on the SLOWEST supported
 * Node (22.13): 150 concurrent hook processes -> slowest transaction 537ms,
 * 300 concurrent -> 644ms. Roughly 8x margin on the load this is built for.
 *
 * Applied via `PRAGMA busy_timeout` rather than the `DatabaseSync` `timeout`
 * constructor option deliberately, and this is not a stylistic choice: that
 * option was added in Node 22.16, and a Node 22.13 that does not know it
 * ACCEPTS IT AND IGNORES IT. The connection would then have no busy handler
 * at all while looking correctly configured, and every contended write would
 * fail instantly instead of waiting. Measured on 22.13 with the constructor
 * option: 66-116 of 150 concurrent writers survived, failing in 2-12ms with
 * SQLITE_BUSY. The pragma is plain SQLite and works on every Node that has
 * `node:sqlite` at all.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000

/** Every SQLite database file starts with these 16 bytes. A 0-byte file is
 *  also a valid, empty SQLite database — SQLite initialises it in place. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

/** The environment variable Tandem stamps into a spawned Claude worker. */
export const SESSION_ID_ENV = 'TANDEM_SESSION_ID'

/**
 * The turn boundaries Claude reports. `stop`/`stop_failure` are kept distinct
 * rather than flattened to "done": a foreman acts differently on a turn that
 * ended cleanly and one that ended in failure, and collapsing them here would
 * make that distinction unrecoverable downstream.
 *
 * `prompt_submit` (Claude's `UserPromptSubmit` hook) is a THIRD, earlier
 * boundary: the moment a prompt lands, whoever sent it. It carries no message
 * — see claude-stop-hook.ts — and exists only so a later `stop`/`stop_failure`
 * can be trusted to belong to the turn Tandem opened rather than to a stray
 * record still sitting in this append-only, shared-by-every-worker store (see
 * claude-completion.ts's claudeTurnEndAfter).
 *
 * `interrupt` and `close` are a FOURTH kind of record, and unlike the three
 * above they are never written by Claude's own hook at all — Tandem writes
 * them itself (see claude-completion.ts's recordClaudeLifecycleBoundary and
 * its two callers in router.ts). They exist because Claude's `Stop` hook does
 * NOT fire when a turn is cut short by an interrupt: Claude simply terminates
 * the turn, and no boundary is ever written to this store. Without a
 * substitute, claude-completion.ts's claudeLifecycleReadiness would see the
 * turn's `prompt_submit` as the latest record forever and report the session
 * `'busy'` for good, blocking every future send to it. `interrupt` is written
 * once Tandem has actually stopped the backend process; `close` is written on
 * every session close, REGARDLESS of whether a turn was pending — a session
 * name is derived deterministically (see claude-worker-env.ts's
 * tandemSessionIdFor), so a session reopened under the same name shares its
 * predecessor's tandemSession identity, and without a `close` marker it would
 * inherit a stale unmatched `prompt_submit` from an incarnation that no
 * longer exists. Both carry no message, ever, and neither is a completion:
 * claude-completion.ts's claudeTurnEndAfter only ever matches `stop`/
 * `stop_failure` after a `prompt_submit`, never these two.
 */
export type ClaudeLifecycleKind = 'stop' | 'stop_failure' | 'prompt_submit' | 'interrupt' | 'close'

/** The single source of truth for which kinds exist. The schema's CHECK
 *  constraint below spells the same five out to SQLite. */
const KINDS: ReadonlySet<string> = new Set<ClaudeLifecycleKind>([
  'stop',
  'stop_failure',
  'prompt_submit',
  'interrupt',
  'close',
])

/**
 * The `claudeSessionId` Tandem-authored records (`interrupt`, `close`) use in
 * place of a real Claude session id — there is no hook payload to take one
 * from, since Claude did not write these. Opaque, constant, and satisfies
 * `isOpaqueIdentity`; it carries no information beyond "this record did not
 * come from Claude's own hook."
 */
export const SYNTHETIC_CLAUDE_SESSION_ID = 'tandem-synthetic'

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
  /** Sanitised, clamped last assistant message (`stop` only, when present).
   *  `stop_failure`, `prompt_submit`, `interrupt` and `close` NEVER carry one
   *  — see `record()`. */
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

/**
 * `node:sqlite`, loaded lazily and memoized.
 *
 * NOT a static import, on purpose. This module sits in the bridge's import
 * graph (router.ts -> claude-completion.ts -> here), so a static import would
 * make a Node without `node:sqlite` fail to start the WHOLE bridge rather than
 * lose one reporting feature. package.json's `engines` states the versions
 * that have it; this is what happens to anyone running outside that range.
 */
type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync }
let sqliteModule: SqliteModule | null | undefined
function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule
  sqliteModule = null
  try {
    const loaded: unknown = createRequire(import.meta.url)('node:sqlite')
    if (loaded && typeof loaded === 'object' && typeof (loaded as SqliteModule).DatabaseSync === 'function') {
      sqliteModule = loaded as SqliteModule
    }
  } catch {
    /* an engine without node:sqlite gets a store that records nothing */
  }
  return sqliteModule
}

/**
 * The schema, applied with IF NOT EXISTS inside the same transaction as every
 * write, so two hook processes racing to create it cannot half-create it.
 *
 * `STRICT` so a column cannot silently hold a value of the wrong type.
 * `AUTOINCREMENT` so `seq` is never reused after a retention delete — that is
 * the whole reason it is spelled out rather than left as a plain rowid alias.
 * The CHECKs are what the DATABASE can enforce; `rowToEvent` re-validates every
 * row on the way out, because a row could still have been written by something
 * other than this code running as the same user.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  epoch           TEXT    NOT NULL CHECK (length(epoch) > 0),
  dropped_through INTEGER NOT NULL DEFAULT 0 CHECK (dropped_through >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms             INTEGER NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('stop','stop_failure','prompt_submit','interrupt','close')),
  tandem_session    TEXT    NOT NULL CHECK (length(tandem_session) BETWEEN 1 AND ${MAX_IDENTITY_CHARS}),
  claude_session_id TEXT    NOT NULL CHECK (length(claude_session_id) BETWEEN 1 AND ${MAX_IDENTITY_CHARS}),
  message           TEXT,
  message_truncated INTEGER NOT NULL DEFAULT 0 CHECK (message_truncated IN (0, 1))
) STRICT;
`

const EVENT_COLUMNS = 'seq, ts_ms, kind, tandem_session, claude_session_id, message, message_truncated'

/** What a read of the store yields, whether or not there is anything there. */
interface StoreState {
  epoch: string
  droppedThrough: number
  /** Highest seq this database ever ISSUED, including seqs retention has since
   *  dropped. 0 when nothing was ever written. */
  highWater: number
}

const EMPTY_STATE: StoreState = { epoch: EMPTY_STORE_EPOCH, droppedThrough: 0, highWater: 0 }

/** Thrown internally when the file on disk is a store this version cannot use;
 *  `record()` catches it, replaces the file, and tries once more. */
class IncompatibleStoreError extends Error {}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/** `record()`'s bounded lock wait. Overridable per-instance — production code
 *  never needs to, but a test proving that a genuinely held write lock degrades
 *  safely needs it far smaller to run fast. */
export interface ClaudeLifecycleStoreOptions {
  busyTimeoutMs?: number
}

/**
 * The durable Claude lifecycle store.
 *
 * `directory` is injectable so tests — and a host running two Tandem instances
 * — never touch real home state. `busyTimeoutMs` is likewise a test seam (see
 * `ClaudeLifecycleStoreOptions`); production code should never need it.
 *
 * INSTANCES HOLD NO STATE AND NO OPEN HANDLE. Every call opens the database,
 * does its work, and closes it. That is what makes a new instance over the same
 * directory behave exactly like a restarted bridge or the next hook process —
 * and it is why deleting the file out from under a live instance (which the
 * tests do, and which anyone with `rm` can do) yields a genuinely fresh store
 * with a new epoch rather than writes into an unlinked inode.
 */
export class ClaudeLifecycleStore {
  private readonly directory: string
  private readonly busyTimeoutMs: number

  constructor(directory: string = tandemStatePath(DIRECTORY), options: ClaudeLifecycleStoreOptions = {}) {
    this.directory = directory
    this.busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))
  }

  private get path(): string {
    return join(this.directory, FILENAME)
  }

  /**
   * Is the file at `path` a database this store may use?
   *
   * `lstat`, never `stat`: a symlink at the database path is never followed.
   * SQLite would happily open the target — which is precisely how a private
   * state directory turns into a write primitive aimed at someone else's file.
   */
  private inspect(): 'ok' | 'missing' | 'foreign' {
    let info
    try {
      info = lstatSync(this.path)
    } catch {
      // ENOENT is the normal first-run case; anything else (a parent that is
      // not a directory, a permission problem) is equally "nothing usable".
      return 'missing'
    }
    if (info.isSymbolicLink() || !info.isFile()) return 'foreign'
    if (info.size > MAX_STORE_BYTES) return 'foreign'
    if ((info.mode & 0o077) !== 0) return 'foreign'
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return 'foreign'
    // A 0-byte file is a valid empty SQLite database, and is what this store
    // creates itself to own the permissions before SQLite ever touches it.
    if (info.size === 0) return 'ok'
    if (info.size < SQLITE_MAGIC.length) return 'foreign'
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'r')
      const header = Buffer.alloc(SQLITE_MAGIC.length)
      const read = readSync(fd, header, 0, header.length, 0)
      return read === header.length && header.equals(SQLITE_MAGIC) ? 'ok' : 'foreign'
    } catch {
      return 'foreign'
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* nothing useful to do about a failed close of a read handle */
        }
      }
    }
  }

  /** Remove a database this store refuses to trust, together with any SQLite
   *  sidecar belonging to it — an orphaned journal left beside a NEW database
   *  would be rolled back into it. Only ever called on the write path, and
   *  `rmSync` on a symlink removes the link, never its target. */
  private discard(): void {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        rmSync(`${this.path}${suffix}`, { force: true })
      } catch {
        /* best effort: whatever survives is refused again on the next attempt */
      }
    }
  }

  /**
   * Open the database for writing, creating and replacing as needed.
   *
   * The empty file is created HERE, 0600, before SQLite sees the path. SQLite
   * would otherwise create it itself at 0666 & ~umask — 0644 on a stock host —
   * and offers no option to say otherwise. Creating it first means the mode is
   * right from the instant the file exists rather than a chmod afterwards, and
   * SQLite then inherits it for the `-journal` sidecar too (verified: a journal
   * beside a 0600 database is itself 0600).
   */
  private openForWrite(): DatabaseSync | undefined {
    const sqlite = loadSqlite()
    if (!sqlite) return undefined
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (this.inspect() === 'foreign') this.discard()
    if (this.inspect() === 'missing') {
      try {
        closeSync(openSync(this.path, 'wx', 0o600))
      } catch (error) {
        // EEXIST: another hook process created it in the same instant, which
        // is fine — it created it in exactly this way.
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      }
      // openSync's mode argument is masked by the umask; this is not.
      chmodSync(this.path, 0o600)
    }
    return this.configure(new sqlite.DatabaseSync(this.path))
  }

  /**
   * Open the database for reading, or `undefined` when there is nothing
   * trustworthy to read. Never creates the file — a read must not bring a store
   * into existence.
   *
   * Opened read-write rather than read-only so a hot journal left by a writer
   * that died mid-commit is rolled back by this open. A read-only handle cannot
   * do that: it would report the store empty until some other process happened
   * to write, which on this path means ignoring a completion that is already
   * durably on disk.
   */
  private openForRead(): DatabaseSync | undefined {
    const sqlite = loadSqlite()
    if (!sqlite) return undefined
    if (this.inspect() !== 'ok') return undefined
    return this.configure(new sqlite.DatabaseSync(this.path))
  }

  /** The one place the bounded lock wait is set. `busy_timeout` takes a
   *  literal, and this one comes from a number this class has already
   *  truncated and floored — never from caller text. */
  private configure(db: DatabaseSync): DatabaseSync {
    db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`)
    return db
  }

  /** The store's version stamp, from the database header. 0 on a database that
   *  has never been initialised, including a 0-byte file. */
  private static userVersion(db: DatabaseSync): number {
    return asInteger(db.prepare('PRAGMA user_version').get()?.user_version) ?? 0
  }

  /** Everything `snapshot` and `readAfter` need about the store as a whole. */
  private static state(db: DatabaseSync): StoreState {
    const meta = db.prepare('SELECT epoch, dropped_through FROM meta WHERE id = 1').get()
    const epoch = typeof meta?.epoch === 'string' && meta.epoch.length > 0 ? meta.epoch : EMPTY_STORE_EPOCH
    const droppedThrough = Math.max(0, asInteger(meta?.dropped_through) ?? 0)
    // The AUTOINCREMENT high-water mark survives retention deletes, so it — not
    // the newest surviving row — is what "highest seq ever issued" means.
    const issued = db
      .prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS issued")
      .get()
    const newest = db.prepare('SELECT COALESCE(MAX(seq), 0) AS newest FROM events').get()
    const highWater = Math.max(0, asInteger(issued?.issued) ?? 0, asInteger(newest?.newest) ?? 0)
    return { epoch, droppedThrough, highWater }
  }

  /**
   * One stored row as an event, or `undefined` if the row is not one.
   *
   * The database enforces what a CHECK constraint can; this enforces what it
   * cannot (the identity grammar, a usable timestamp) so a single bad row —
   * written by hand, or by a future version — costs that row and not the whole
   * store. `id` is DERIVED rather than stored: it is a pure function of the
   * epoch, the two identities, the kind and the seq, so the value `record()`
   * returns and the value a later read returns cannot drift, and there is no id
   * column for a stray writer to put something arbitrary in.
   */
  private static rowToEvent(row: Record<string, unknown>, epoch: string): ClaudeLifecycleEvent | undefined {
    const seq = asInteger(row.seq)
    const tsMs = asInteger(row.ts_ms)
    const kind = row.kind
    const tandemSession = row.tandem_session
    const claudeSessionId = row.claude_session_id
    if (seq === undefined || seq <= 0) return undefined
    if (tsMs === undefined) return undefined
    if (typeof kind !== 'string' || !KINDS.has(kind)) return undefined
    if (!isOpaqueIdentity(tandemSession) || !isOpaqueIdentity(claudeSessionId)) return undefined
    let ts: string
    try {
      ts = new Date(tsMs).toISOString()
    } catch {
      return undefined
    }
    const message = typeof row.message === 'string' && row.message.length > 0 ? row.message : undefined
    return {
      v: CLAUDE_LIFECYCLE_VERSION,
      id: eventId(epoch, tandemSession, claudeSessionId, kind as ClaudeLifecycleKind, seq),
      seq,
      ts,
      kind: kind as ClaudeLifecycleKind,
      tandemSession,
      claudeSessionId,
      ...(message ? { message } : {}),
      ...(row.message_truncated === 1 ? { messageTruncated: true } : {}),
    }
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
      if (!KINDS.has(input.kind)) return undefined
      if (!isOpaqueIdentity(input.tandemSession)) return undefined
      if (!isOpaqueIdentity(input.claudeSessionId)) return undefined
      try {
        return this.insert(input)
      } catch (error) {
        // A database written by a version whose schema this one does not know.
        // Replacing it is the documented behaviour of a version bump ("older
        // state is discarded"), and one retry is enough because the retry runs
        // against a file this process just created.
        if (!(error instanceof IncompatibleStoreError)) throw error
        this.discard()
        return this.insert(input)
      }
    } catch {
      return undefined
    }
  }

  /**
   * The whole write, as ONE SQLite transaction: schema, epoch, insert,
   * retention and the dropped-through watermark either all land or none do.
   *
   * `BEGIN IMMEDIATE`, not a bare `BEGIN`. A deferred transaction takes a read
   * lock first and only tries to upgrade to a write lock at its first write,
   * and SQLite refuses to run the busy handler for that upgrade (two upgraders
   * would deadlock), returning SQLITE_BUSY at once instead of waiting.
   * `IMMEDIATE` takes the write lock up front, where `busy_timeout` applies —
   * which is what makes the bounded wait actually bound anything.
   */
  private insert(input: ClaudeLifecycleInput): ClaudeLifecycleEvent | undefined {
    const db = this.openForWrite()
    if (!db) return undefined
    try {
      const version = ClaudeLifecycleStore.userVersion(db)
      if (version !== 0 && version !== CLAUDE_LIFECYCLE_VERSION) throw new IncompatibleStoreError()

      const now = input.now ?? new Date()
      // Throws on an unusable Date, before anything has been written.
      const ts = now.toISOString()
      const tsMs = now.getTime()

      // Only `stop` ever carries a message. `stop_failure` has none to carry;
      // `prompt_submit`, `interrupt` and `close` carry NONE, unconditionally —
      // this is a hard invariant, not merely "usually omitted": neither the
      // hook (prompt_submit) nor Tandem itself (interrupt/close) is trusted to
      // have withheld content on the caller's side. This store enforces it
      // independently, even if a future caller passed one through by mistake.
      const raw = input.kind === 'stop' && typeof input.message === 'string' ? input.message : undefined
      const sanitized = raw ? sanitizeEventText(raw, MAX_MESSAGE_CHARS) : undefined
      const message = sanitized && sanitized.length > 0 ? sanitized : undefined
      // "Truncated" is about the CLAMP, not about redaction: the sanitiser also
      // shortens text by replacing secrets, and calling that truncation would
      // mislead a reader into thinking the tail was lost.
      const messageTruncated = raw !== undefined && raw.length > MAX_MESSAGE_CHARS

      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(SCHEMA)
        // Interpolated because PRAGMA takes no bound parameters; the value is
        // this module's own integer constant, never anything from a caller.
        if (version === 0) db.exec(`PRAGMA user_version = ${CLAUDE_LIFECYCLE_VERSION}`)
        // Mint the real store epoch on the first write that lands. Whichever
        // writer gets here first wins; every other one's INSERT is ignored and
        // it reads that same epoch straight back.
        db.prepare('INSERT OR IGNORE INTO meta (id, epoch, dropped_through) VALUES (1, ?, 0)').run(
          randomBytes(8).toString('hex'),
        )
        const epoch = db.prepare('SELECT epoch FROM meta WHERE id = 1').get()?.epoch
        if (typeof epoch !== 'string' || epoch.length === 0) throw new Error('lifecycle store has no epoch')

        const inserted = db
          .prepare(
            `INSERT INTO events (ts_ms, kind, tandem_session, claude_session_id, message, message_truncated)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
          )
          .get(
            tsMs,
            input.kind,
            input.tandemSession,
            input.claudeSessionId,
            message ?? null,
            messageTruncated ? 1 : 0,
          )
        const seq = asInteger(inserted?.seq)
        if (seq === undefined || seq <= 0) throw new Error('lifecycle store issued no sequence')

        // Retention, in the same transaction as the insert. Neither delete
        // touches `sqlite_sequence`, so dropping a row never frees its seq for
        // reuse — the next insert always gets a strictly higher one.
        db.prepare('DELETE FROM events WHERE ts_ms < ?').run(tsMs - MAX_EVENT_AGE_MS)
        db.prepare('DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?)').run(
          MAX_RETAINED_EVENTS,
        )

        // How far history has been dropped, so a reader holding an older seq
        // can be told its window no longer covers everything.
        const oldestKept = asInteger(db.prepare('SELECT MIN(seq) AS oldest FROM events').get()?.oldest) ?? seq + 1
        db.prepare('UPDATE meta SET dropped_through = max(dropped_through, ?) WHERE id = 1').run(
          Math.max(0, oldestKept - 1),
        )

        db.exec('COMMIT')

        return {
          v: CLAUDE_LIFECYCLE_VERSION,
          id: eventId(epoch, input.tandemSession, input.claudeSessionId, input.kind, seq),
          seq,
          ts,
          kind: input.kind,
          tandemSession: input.tandemSession,
          claudeSessionId: input.claudeSessionId,
          ...(message ? { message } : {}),
          ...(messageTruncated ? { messageTruncated: true } : {}),
        }
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* already rolled back, or never begun */
        }
        throw error
      }
    } finally {
      try {
        db.close()
      } catch {
        /* nothing useful to do about a failed close */
      }
    }
  }

  /**
   * Where the store is right now. A caller takes this BEFORE the work it wants
   * to observe the effect of, then passes `seq` to readAfter.
   *
   * Never throws: an unreadable store reports an empty one.
   */
  snapshot(): ClaudeLifecycleCursor {
    const state = this.read((db) => ClaudeLifecycleStore.state(db)) ?? EMPTY_STATE
    return { seq: state.highWater, storeEpoch: state.epoch }
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
    const after = Number.isSafeInteger(seq) && seq > 0 ? seq : 0
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_RETAINED_EVENTS))

    const read = this.read((db) => ({
      state: ClaudeLifecycleStore.state(db),
      // One row past the page, so "is there more" costs no second query.
      rows: db
        .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
        .all(after, limit + 1),
    }))
    const state = read?.state ?? EMPTY_STATE
    const rows = read?.rows ?? []

    const more = rows.length > limit
    const events: ClaudeLifecycleEvent[] = []
    let consumedThrough = after
    for (const row of rows.slice(0, limit)) {
      const event = ClaudeLifecycleStore.rowToEvent(row, state.epoch)
      if (event) events.push(event)
      // Advance past rows that were read but refused, too, so a page made
      // entirely of unusable rows still moves the cursor forward instead of
      // handing the caller the same rows for ever.
      const rawSeq = asInteger(row.seq)
      if (rawSeq !== undefined && rawSeq > consumedThrough) consumedThrough = rawSeq
    }

    const epochChanged =
      opts.storeEpoch !== undefined && opts.storeEpoch !== EMPTY_STORE_EPOCH && opts.storeEpoch !== state.epoch

    return {
      version: CLAUDE_LIFECYCLE_VERSION,
      events,
      seq: Math.max(after, state.droppedThrough, consumedThrough),
      storeEpoch: state.epoch,
      more,
      // Only a genuine gap counts: the caller asked for everything after a seq
      // that retention has already dropped past, or the store was replaced.
      truncated: epochChanged || after < state.droppedThrough,
    }
  }

  /** Run a read against the store, or return `undefined` when there is nothing
   *  trustworthy to read or the read itself fails. The single place the read
   *  paths' "degrade to empty, never throw" promise is kept. */
  private read<T>(fn: (db: DatabaseSync) => T): T | undefined {
    let db: DatabaseSync | undefined
    try {
      db = this.openForRead()
      if (!db) return undefined
      if (ClaudeLifecycleStore.userVersion(db) !== CLAUDE_LIFECYCLE_VERSION) return undefined
      return fn(db)
    } catch {
      return undefined
    } finally {
      if (db) {
        try {
          db.close()
        } catch {
          /* nothing useful to do about a failed close */
        }
      }
    }
  }
}

/** The record id: a pure function of the store's identity, the two supplied
 *  identities, the kind and the seq. Derived in exactly one place so the value
 *  `record()` returns and the value `readAfter()` returns are the same by
 *  construction rather than by agreement. */
function eventId(
  epoch: string,
  tandemSession: string,
  claudeSessionId: string,
  kind: ClaudeLifecycleKind,
  seq: number,
): string {
  return (
    'cl_' +
    createHash('sha256')
      .update([epoch, tandemSession, claudeSessionId, kind, String(seq)].join(' '))
      .digest('hex')
      .slice(0, 20)
  )
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
