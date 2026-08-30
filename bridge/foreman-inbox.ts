/**
 * foreman-inbox.ts — the durable, bounded, queryable projection of Tandem's
 * completion events, for a foreman that was not connected when they happened.
 *
 * THE PROBLEM. Tandem workers outlive the conversation driving them. A turn
 * that finishes while the foreman is away is otherwise only reachable by
 * polling the session that produced it — and a foreman that lost its context
 * does not know which sessions to poll. Meanwhile no MCP client can be woken by
 * this server (docs/foreman-events.md carries the protocol evidence), so "push
 * harder" is not on the table. The durable answer is reconciliation: the host
 * remembers what finished, and the foreman asks on its next turn.
 *
 * ONE EMIT PATH, ONE PROJECTION. bridge/events.ts remains the sole emitter of
 * completion truth; this module is a store it writes into, alongside the
 * existing events.log / webhook / ntfy sinks. Whether a transition happened at
 * all is decided once, upstream, at the turn boundary (bridge/turn-ledger.ts),
 * so every sink agrees. Nothing here decides that a turn finished.
 *
 * WHAT IS DELIBERATELY NOT STORED (see SECURITY.md). This store is readable by
 * the connected MCP client, so it holds bounded, non-secret, structured
 * metadata only: no working directory, no filesystem path, no attach hint, no
 * handoff block, no git facts, no environment, no tool arguments, no transcript.
 * The one free-text pair (`summary`, `reason`) is clamped to 200 characters and
 * passed through sanitizeEventText(). That strips control sequences and
 * redacts credentials, URLs, email addresses, tailnet host names and addresses,
 * and ABSOLUTE filesystem locations (POSIX, home-relative, Windows and UNC).
 * It deliberately keeps RELATIVE paths such as "src/router.ts": they name a
 * file inside the repository the worker was already told to work in, carry no
 * host or account identity, and are most of what makes a summary worth
 * reading. A host that wants none of it sets
 * TANDEM_FOREMAN_EVENT_SUMMARIES=0.
 *
 * LIVENESS IS NOT HISTORY. An event says a transition happened; it never says a
 * worker is or is not alive now. list_sessions is the only liveness truth — the
 * tool description and the orchestration policy both say so, because a foreman
 * that reads a stale `completed` as "that worker is finished with" will open a
 * duplicate against a session that is still running.
 *
 * CHECKPOINTS, NOT ACKNOWLEDGEMENTS. Tandem's HTTP transport is stateless
 * (sessionIdGenerator: undefined — a fresh McpServer and transport per
 * request), so the server has no client identity to attribute an
 * acknowledgement to. A server-side "acked" flag would be one global watermark
 * shared by every conversation, phone, and script on the machine: whoever read
 * last would silently hide events from everyone else. Instead the READER
 * carries an opaque checkpoint and hands it back — per-client by construction,
 * needing no writable state on the read path, and impossible for a concurrent
 * reader to corrupt. See docs/foreman-events.md for the full rationale.
 *
 * TRUST MODEL: mirrors herdr-cursor-store.ts — one owner-only file (0600) in a
 * 0700 private directory, replaced atomically via rename, rejected rather than
 * trusted when anything is off. Rejection degrades to an empty inbox.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tandemStatePath } from './state-dir.ts'
import { InvalidCheckpointError } from './foreman-checkpoint.ts'

export { InvalidCheckpointError } from './foreman-checkpoint.ts'

/** Bumped whenever the on-disk or wire shape below changes. */
export const FOREMAN_EVENT_VERSION = 1

const DIRECTORY = 'foreman'
const FILENAME = 'events.json'
/** Retention bounds — enforced on every write, BEFORE any reader can see the
 *  store, so the file cannot grow without limit on a long-lived host. */
export const MAX_RETAINED_EVENTS = 400
const MAX_EVENT_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_STORE_BYTES = 2 * 1024 * 1024
/** The hard clamp on every free-text field that leaves this host. */
export const MAX_TEXT_CHARS = 200
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
/** How many recent transitions the list_sessions preview may carry, and the
 *  hard ceiling a caller-supplied preview size is clamped to. Deliberately
 *  tiny: the preview is a nudge to reconcile, never the history surface. */
export const DEFAULT_PREVIEW_EVENTS = 5
export const MAX_PREVIEW_EVENTS = 5
/** Total serialized budget for the preview array. A backstop against a store
 *  written by a future version, or by hand, whose records are larger than the
 *  clamps below would suggest. */
const MAX_PREVIEW_BYTES = 8 * 1024
/** The preview's own text clamp, applied on the READ path (see previewEvent). */
export const MAX_PREVIEW_TEXT_CHARS = 160

/**
 * The real lifecycle transitions. Each is a boundary a foreman would act on
 * differently — there is deliberately no single `status: "done"` flattened
 * across all of them.
 */
export type ForemanEventKind =
  | 'completed'
  | 'blocked'
  | 'needs_input'
  | 'interrupted'
  | 'closed'
  | 'error'

/** Transitions that should pull a foreman's attention on its next turn. */
const REVIEWABLE: ReadonlySet<ForemanEventKind> = new Set<ForemanEventKind>([
  'completed',
  'blocked',
  'needs_input',
  'interrupted',
  'error',
])

export interface ForemanEvent {
  v: number
  /** Stable, content-derived id: the same transition of the same turn on the
   *  same incarnation always hashes to the same value. */
  id: string
  /** Monotonic per-store ordinal; the checkpoint is built from it. */
  seq: number
  ts: string
  kind: ForemanEventKind
  /** Which subsystem produced it. */
  source: 'session' | 'relay'
  /** This host's fleet device id, or "local" when it is the hub itself. */
  device: string
  /** The name as this host knows it. */
  localName: string
  /** The composite "<device>:<localName>" a foreman must use to address it. */
  session: string
  engine?: string
  /** Incarnation counter — a reopened name is a different agent (turn-ledger). */
  epoch: number
  /** Turn ordinal within that incarnation. */
  turn: number
  /** Transcript cursor at the boundary; hand it back to send_to_session to
   *  resume reading. Informational only — never an identity. */
  cursor?: number
  summary?: string
  reason?: string
  needs_foreman_review: boolean
}

interface StoreFile {
  version: number
  /** Regenerated whenever the store is created fresh, so a checkpoint issued by
   *  a previous store is detectable instead of silently misinterpreted. */
  epoch: string
  nextSeq: number
  /** Highest seq retention has dropped; anything at or below it is gone. */
  droppedThrough: number
  events: ForemanEvent[]
}

/* -------------------------------------------------------------------------- */
/* outbound text sanitising                                                    */
/* -------------------------------------------------------------------------- */

/** Credential- and location-shaped runs, redacted before anything leaves the host. */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN[^-]{0,64}PRIVATE KEY-----[\s\S]*?(?:-----END[^-]{0,64}-----|$)/g, '<key>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt>'],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g, '<token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '<token>'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<token>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '<token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<token>'],
  [/\b(password|passwd|secret|token|api[_-]?key|authorization|bearer)\b\s*[:=]\s*\S+/gi, '$1=<redacted>'],
  // URLs before paths: a URL's own "/a/b" must not be rewritten piecemeal.
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>'],
  // Email addresses — a person's identity, not a diagnostic.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  // Tailscale identity: MagicDNS names and the 100.64.0.0/10 CGNAT range the
  // tailnet uses. Both name a machine on the user's private network.
  [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/gi, '<tailnet-host>'],
  [/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, '<tailnet-ip>'],
  // ABSOLUTE filesystem locations only: POSIX "/a/b", home-relative "~/a", and
  // Windows "C:\\a\\b" or a UNC "\\\\host\\share". A RELATIVE path such as
  // "src/router.ts" is deliberately kept: it names a file inside the repo the
  // worker was already asked to work on, carries no host or account identity,
  // and is most of what makes a summary worth reading.
  [/\b[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/])*[^\s\\/:*?"<>|]*/g, '<path>'],
  [/\\\\[A-Za-z0-9._-]+\\[^\s]*/g, '<path>'],
  [/~\/\S*/g, '<path>'],
  // The lookbehind is what keeps a RELATIVE path intact: the leading slash must
  // not itself follow a path character, so "/etc/hosts" and "/Users/x/a.ts"
  // match while "src/router.ts" and "2/3" do not.
  [/(?<![A-Za-z0-9._+~-])\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]*)*/g, '<path>'],
  // Long opaque runs (hex digests, base64 blobs) that no summary needs.
  [/\b[A-Fa-f0-9]{32,}\b/g, '<redacted>'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<redacted>'],
]

/**
 * Make one line of engine output safe to hand to a connected MCP client: strip
 * ANSI/control bytes, redact credential- and location-shaped runs, collapse
 * whitespace, clamp hard.
 *
 * Exported so the redaction policy is testable on its own rather than only
 * through a store write.
 */
export function sanitizeEventText(raw: string, max: number = MAX_TEXT_CHARS): string {
  let text = raw
    // ANSI/CSI escape sequences first, then any remaining C0/DEL control byte.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** Host opt-out: drop the free-text fields entirely. */
function summariesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TANDEM_FOREMAN_EVENT_SUMMARIES?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

/** This host's fleet device id, or "local" when it is the hub itself. */
export function currentDeviceId(env: NodeJS.ProcessEnv = process.env): string {
  return env.TANDEM_DEVICE_ID?.trim() || 'local'
}

/* -------------------------------------------------------------------------- */
/* checkpoints                                                                 */
/* -------------------------------------------------------------------------- */

const CHECKPOINT_PREFIX = 'fe1_'
/**
 * The store epoch used while nothing has been persisted yet. It must be
 * DETERMINISTIC: a reader that checkpoints an empty inbox and comes back later
 * would otherwise be told its checkpoint came from "a different store" and that
 * history was truncated, when in fact it has simply seen nothing yet.
 */
const EMPTY_STORE_EPOCH = '0'

function encodeCheckpoint(storeEpoch: string, seq: number): string {
  return CHECKPOINT_PREFIX + Buffer.from(`${storeEpoch}.${seq}`, 'utf8').toString('base64url')
}

function decodeCheckpoint(token: string): { storeEpoch: string; seq: number } {
  if (!token.startsWith(CHECKPOINT_PREFIX)) {
    throw new InvalidCheckpointError('checkpoint is not a Tandem foreman checkpoint')
  }
  let decoded: string
  try {
    decoded = Buffer.from(token.slice(CHECKPOINT_PREFIX.length), 'base64url').toString('utf8')
  } catch {
    throw new InvalidCheckpointError('checkpoint is not decodable')
  }
  const dot = decoded.lastIndexOf('.')
  const storeEpoch = decoded.slice(0, dot)
  const seq = Number(decoded.slice(dot + 1))
  if (dot <= 0 || !Number.isSafeInteger(seq) || seq < 0) {
    throw new InvalidCheckpointError('checkpoint is malformed')
  }
  return { storeEpoch, seq }
}

/* -------------------------------------------------------------------------- */
/* the store                                                                   */
/* -------------------------------------------------------------------------- */

/** What a caller supplies; every derived and safety-critical field is computed here. */
export interface ForemanEventInput {
  kind: ForemanEventKind
  source: 'session' | 'relay'
  localName: string
  /** Incarnation and turn coordinates from bridge/turn-ledger.ts. */
  epoch: number
  turn: number
  engine?: string
  cursor?: number
  summary?: string
  reason?: string
  device?: string
  /** Test seam only. */
  now?: Date
}

export interface ForemanEventPage {
  version: number
  events: ForemanEvent[]
  /** Hand this back as `since` on the next call. */
  checkpoint: string
  /** Retained events the caller has not seen remain AFTER this page. Purely a
   *  pagination fact: call again with the returned checkpoint to collect them. */
  more: boolean
  /** Events the caller never saw are GONE — retention rotated them away before
   *  this read, or the checkpoint was issued by a store that no longer exists.
   *  Never set merely because a page was cut short by `limit`; that is `more`. */
  truncated: boolean
  counts: { returned: number; retained: number }
}

/**
 * The bounded recent-transition summary carried ADDITIVELY on a list_sessions
 * response (see bridge/router.ts's GET /sessions).
 *
 * WHY IT EXISTS AT ALL, given get_foreman_events already answers this better.
 * An MCP client caches a server's tool list for the life of a conversation. A
 * chat that was already open when this server gained `get_foreman_events` — or
 * gains any later tool — never sees it, because nothing in the protocol makes a
 * connected client re-read the schema, and no server can wake one to ask. That
 * client still calls `list_sessions`, because it is one of the tools it cached.
 * So the one place a completion can still reach a stale conversation is a field
 * on a tool it already knows about.
 *
 * IT IS A PREVIEW, NOT A FEED. It carries no cursor of the caller's, cannot be
 * paged, is capped at DEFAULT_PREVIEW_EVENTS, and is ordered NEWEST FIRST so it
 * reads as a summary rather than as a page of history. `get_foreman_events`
 * stays the preferred surface for anything checkpointed: it is the only one
 * that can tell a caller it has seen everything exactly once.
 *
 * THE SAME TWO RULES STILL HOLD. These are HISTORY — `sessions` in the same
 * response is the LIVENESS truth, and a `completed` here is not proof a worker
 * exited. And the `checkpoint` is the store's position AT THE NEWEST RETAINED
 * EVENT — which is also the newest event actually shown, whenever anything was
 * shown at all — so handing it to get_foreman_events as `since` deliberately
 * skips everything at or before it: only do that once these have been acted on.
 */
export interface ForemanEventPreview {
  version: number
  /** Newest first, at most DEFAULT_PREVIEW_EVENTS. */
  events: ForemanEvent[]
  /** Opaque store position at the newest event shown (see above). */
  checkpoint: string
  /** Retained transitions exist that this preview did not show. */
  older: boolean
  counts: { shown: number; retained: number }
  /** One line stating what this is and is not; carried in the response so a
   *  client with a cached tool schema reads it even though the tool
   *  description it has is older than this field. */
  note: string
}

export const FOREMAN_PREVIEW_NOTE =
  'Recent transitions, newest first, preview only. HISTORY, not liveness: `sessions` above is what is running now. Use get_foreman_events with your own checkpoint for complete, once-only history.'

/**
 * Re-clamp one stored event for the preview surface.
 *
 * Every field here was already sanitized when it was recorded, so this is
 * defence in depth rather than the primary control — but the primary control
 * ran in a possibly older version of this process, against a file on disk that
 * a later version, a restore, or a hand edit could have changed. The preview
 * rides on `list_sessions`, the one tool every stale client still calls, so it
 * re-applies the redaction and clamps the text harder rather than trusting
 * what it loaded.
 */
function previewEvent(event: ForemanEvent): ForemanEvent {
  const clamp = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value === '') return undefined
    const text = sanitizeEventText(value, MAX_PREVIEW_TEXT_CHARS)
    return text === '' ? undefined : text
  }
  const summary = clamp(event.summary)
  const reason = clamp(event.reason)
  return {
    v: event.v,
    id: event.id,
    seq: event.seq,
    ts: event.ts,
    kind: event.kind,
    source: event.source,
    device: event.device,
    localName: event.localName,
    session: event.session,
    ...(event.engine ? { engine: event.engine } : {}),
    epoch: event.epoch,
    turn: event.turn,
    ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
    ...(summary ? { summary } : {}),
    ...(reason ? { reason } : {}),
    needs_foreman_review: event.needs_foreman_review === true,
  }
}

function isStoreFile(value: unknown): value is StoreFile {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    c.version === FOREMAN_EVENT_VERSION &&
    typeof c.epoch === 'string' &&
    c.epoch.length > 0 &&
    typeof c.nextSeq === 'number' &&
    Number.isSafeInteger(c.nextSeq) &&
    typeof c.droppedThrough === 'number' &&
    Number.isSafeInteger(c.droppedThrough) &&
    Array.isArray(c.events)
  )
}

export class ForemanInbox {
  private readonly directory: string

  constructor(directory: string = tandemStatePath(DIRECTORY)) {
    this.directory = directory
  }

  private get path(): string {
    return join(this.directory, FILENAME)
  }

  private load(): StoreFile {
    const fresh = (): StoreFile => ({
      version: FOREMAN_EVENT_VERSION,
      epoch: EMPTY_STORE_EPOCH,
      nextSeq: 1,
      droppedThrough: 0,
      events: [],
    })
    try {
      const info = lstatSync(this.path)
      if (!info.isFile() || info.size > MAX_STORE_BYTES) return fresh()
      if ((info.mode & 0o077) !== 0) return fresh()
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return fresh()
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!isStoreFile(parsed)) return fresh()
      // Drop individually malformed records rather than the whole store.
      return {
        ...parsed,
        events: parsed.events.filter((e) => e && typeof e === 'object' && Number.isSafeInteger(e.seq)),
      }
    } catch {
      return fresh()
    }
  }

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
   *  reader can be told its checkpoint no longer covers everything. */
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
   * Record one lifecycle transition. Idempotent by construction: the id is
   * derived from (device, name, epoch, turn, kind), so re-recording the same
   * transition of the same turn is a no-op. Returns the stored event, or
   * `undefined` when it was a duplicate or could not be written.
   *
   * Never throws — a foreman inbox that cannot be written must not take down
   * the session it was reporting on.
   */
  record(input: ForemanEventInput): ForemanEvent | undefined {
    try {
      const device = input.device ?? currentDeviceId()
      const session = `${device}:${input.localName}`
      const id =
        'fe_' +
        createHash('sha256')
          .update([device, input.localName, String(input.epoch), String(input.turn), input.kind].join(' '))
          .digest('hex')
          .slice(0, 20)

      const loaded = this.load()
      // Mint the real store epoch on the first persisted write; until then the
      // store carries the deterministic empty-store epoch (see above).
      const store =
        loaded.epoch === EMPTY_STORE_EPOCH ? { ...loaded, epoch: randomBytes(8).toString('hex') } : loaded
      if (store.events.some((e) => e.id === id)) return undefined

      const keepText = summariesEnabled()
      const now = input.now ?? new Date()
      const event: ForemanEvent = {
        v: FOREMAN_EVENT_VERSION,
        id,
        seq: store.nextSeq,
        ts: now.toISOString(),
        kind: input.kind,
        source: input.source,
        device,
        localName: input.localName,
        session,
        ...(input.engine ? { engine: input.engine } : {}),
        epoch: input.epoch,
        turn: input.turn,
        ...(input.cursor !== undefined && Number.isSafeInteger(input.cursor) ? { cursor: input.cursor } : {}),
        ...(keepText && input.summary ? { summary: sanitizeEventText(input.summary) } : {}),
        ...(keepText && input.reason ? { reason: sanitizeEventText(input.reason) } : {}),
        needs_foreman_review: REVIEWABLE.has(input.kind),
      }

      this.persist(
        this.applyRetention(
          { ...store, nextSeq: store.nextSeq + 1, events: [...store.events, event] },
          now.getTime(),
        ),
      )
      return event
    } catch {
      return undefined
    }
  }

  /**
   * Read FORWARD from the caller's position, oldest first.
   *
   * The position is the supplied checkpoint, or the start of retained history
   * when there is none. Paging is therefore uniform: every call moves forward,
   * and the returned checkpoint is exactly how far this page reached — so a
   * page cut short by `limit` never skips the remainder.
   *
   * That uniformity is what lets the two flags mean one thing each. `more` is
   * pagination: unread events are still retained. `truncated` is loss: events
   * the caller never saw are gone, because retention rotated them away or the
   * checkpoint came from a store that no longer exists. A page cut short by
   * `limit` is `more`, never `truncated`.
   */
  /**
   * The newest retained transitions, newest first, for the additive
   * list_sessions summary (see ForemanEventPreview above).
   *
   * READ-ONLY AND NEVER THROWING. It rides on list_sessions, which must keep
   * working exactly as it did before this field existed; an inbox that cannot
   * be read degrades to an empty preview, never to a failed listing.
   */
  preview(limit: number = DEFAULT_PREVIEW_EVENTS): ForemanEventPreview {
    const empty = (): ForemanEventPreview => ({
      version: FOREMAN_EVENT_VERSION,
      events: [],
      checkpoint: encodeCheckpoint(EMPTY_STORE_EPOCH, 0),
      older: false,
      counts: { shown: 0, retained: 0 },
      note: FOREMAN_PREVIEW_NOTE,
    })
    try {
      const store = this.load()
      const retained = store.events.length
      const highestSeq = retained > 0 ? store.events[retained - 1]!.seq : store.droppedThrough
      const want = Math.min(Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : DEFAULT_PREVIEW_EVENTS)), MAX_PREVIEW_EVENTS)

      // Newest first: take from the tail, then reverse.
      let events = store.events.slice(Math.max(0, retained - want)).reverse().map(previewEvent)
      // Byte backstop — shed the OLDEST of the preview until it fits.
      while (events.length > 1 && Buffer.byteLength(JSON.stringify(events), 'utf8') > MAX_PREVIEW_BYTES) {
        events.pop()
      }
      if (events.length === 1 && Buffer.byteLength(JSON.stringify(events), 'utf8') > MAX_PREVIEW_BYTES) events = []

      return {
        version: FOREMAN_EVENT_VERSION,
        events,
        // The position AT the newest RETAINED event, which is also the newest
        // event shown whenever anything was shown at all.
        checkpoint: encodeCheckpoint(store.epoch, highestSeq),
        older: retained > events.length || store.droppedThrough > 0,
        counts: { shown: events.length, retained },
        note: FOREMAN_PREVIEW_NOTE,
      }
    } catch {
      return empty()
    }
  }

  read(opts: { since?: string; limit?: number } = {}): ForemanEventPage {
    const store = this.load()
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_PAGE_LIMIT)), MAX_PAGE_LIMIT)
    const retained = store.events.length
    const highestSeq = retained > 0 ? store.events[retained - 1]!.seq : store.droppedThrough

    let candidates: ForemanEvent[]
    let truncated: boolean

    if (opts.since === undefined) {
      // No position yet: start at the oldest thing still retained. Anything
      // rotated away before this first read is genuinely lost to the caller.
      candidates = store.events
      truncated = store.droppedThrough > 0
    } else {
      const { storeEpoch, seq } = decodeCheckpoint(opts.since)
      if (storeEpoch === EMPTY_STORE_EPOCH) {
        // A position taken from an inbox that had never been written to. The
        // caller has seen nothing, so this behaves exactly like a first read.
        candidates = store.events
        truncated = store.droppedThrough > 0
      } else if (storeEpoch !== store.epoch) {
        // A different store issued that checkpoint (reset, restore, or another
        // host). Its sequence numbers mean nothing here, and whatever the
        // caller had seen is unreachable — say so rather than silently
        // replaying everything or silently skipping everything.
        candidates = store.events
        truncated = true
      } else {
        candidates = store.events.filter((e) => e.seq > seq)
        // Retention dropped events that fall after the caller's position.
        truncated = seq < store.droppedThrough
      }
    }

    const events = candidates.slice(0, limit)
    const more = candidates.length > events.length
    const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : highestSeq
    return {
      version: FOREMAN_EVENT_VERSION,
      events,
      checkpoint: encodeCheckpoint(store.epoch, more ? lastSeq : Math.max(lastSeq, highestSeq)),
      more,
      truncated,
      counts: { returned: events.length, retained },
    }
  }
}

/** Process-wide inbox, memoized per resolved directory (see defaultTurnLedger). */
const inboxes = new Map<string, ForemanInbox>()
export function defaultForemanInbox(): ForemanInbox {
  const directory = tandemStatePath(DIRECTORY)
  let inbox = inboxes.get(directory)
  if (!inbox) {
    inbox = new ForemanInbox(directory)
    inboxes.set(directory, inbox)
  }
  return inbox
}
