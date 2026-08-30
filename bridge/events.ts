/**
 * events.ts — the completion-event EMIT side.
 *
 * When a session turn or a relay reaches "done" (per the engine's existing
 * idle/done detection), the bridge calls emitCompletion() instead of waiting to
 * be polled. Two sinks, both best-effort and non-blocking:
 *
 *   1. Append one JSON line to ~/.tandem/events.log (durable; tail/poll it).
 *   2. If TANDEM_DONE_WEBHOOK is set, POST the same JSON to that URL
 *      (fire-and-forget; uses the global fetch in Node 22+, no deps).
 *   3. If TANDEM_NTFY_TOPIC is set, push a phone notification via ntfy
 *      (fire-and-forget; POST to {TANDEM_NTFY_SERVER}/{topic}). This pings a
 *      DEVICE (your phone), not the chat client — see the README ntfy note.
 *
 *   4. Record the same transition in the FOREMAN INBOX
 *      (./foreman-inbox.ts), the bounded, checkpointed store a returning
 *      foreman reads through the get_foreman_events MCP tool. Sink 1 stays the
 *      raw local notification log; sink 4 is the redacted, queryable, bounded
 *      projection of it. Both are written from here so there is exactly one
 *      emit path and the two can never disagree about what happened.
 *
 * The MCP connection itself cannot carry a server-initiated wake-up: the
 * installed SDK has no subscription/listen primitive and Tandem's HTTP
 * transport is stateless, so nothing here can resume a dormant conversation in
 * any client. See docs/foreman-events.md for the protocol evidence and the
 * adapter seam a future client-side capability would plug into.
 *
 * THIS MODULE DOES NOT DECIDE THAT A TURN FINISHED. Callers pass a turn
 * coordinate obtained from ./turn-ledger.ts, which claims each turn's
 * completion exactly once, durably. That is what stops a repeated poll from
 * manufacturing a second completion for one turn — in every sink at once.
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { audit } from './audit.ts'
import { defaultForemanInbox, type ForemanEventKind } from './foreman-inbox.ts'
import { tandemStateDir } from './state-dir.ts'

/** Resolved per write, not at module load: a test (or a host running two
 *  instances) can point TANDEM_STATE_DIR somewhere else without having to
 *  control this module's import order. */
export function eventsLogPath(): string {
  return join(tandemStateDir(), 'events.log')
}
/** Append a metadata-only bridge record using the central redaction policy. */
function logBridge(fields: Record<string, unknown>): void {
  audit(fields)
}

/** Append private event content without inheriting a permissive process umask. */
function appendEventLine(line: string): void {
  const directory = tandemStateDir()
  const log = eventsLogPath()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  appendFileSync(log, line, { encoding: 'utf8', mode: 0o600 })
  chmodSync(log, 0o600)
}

/**
 * The coordinate of the turn (or session incarnation) this event belongs to,
 * obtained from ./turn-ledger.ts. It is what makes an event id stable across
 * repeated polls, a re-adoption, and a bridge restart, and distinct across
 * close/reopen cycles of the same session name.
 *
 * Required, not optional: an event without one could not be de-duplicated, and
 * silently dropping such events from the foreman inbox would be worse than
 * refusing to compile.
 */
export interface EmitTurn {
  epoch: number
  turn: number
  engine?: string
  /** Overrides the device id in the recorded event (fleet callers). */
  device?: string
}

/**
 * Record the transition in the foreman inbox. Best-effort and never throwing:
 * the inbox is a reporting surface, and failing to write it must not break the
 * session it describes.
 */
function recordForeman(
  kind: ForemanEventKind,
  ev: { type: 'session' | 'relay'; id: string; cursor?: number; summary?: string; reason?: string },
  turn: EmitTurn,
): void {
  defaultForemanInbox().record({
    kind,
    source: ev.type,
    localName: ev.id,
    epoch: turn.epoch,
    turn: turn.turn,
    engine: turn.engine,
    device: turn.device,
    cursor: ev.cursor,
    summary: ev.summary,
    reason: ev.reason,
  })
}

export interface CompletionEvent {
  /** "session" (a single turn finished) or "relay" (a relay loop finished). */
  type: 'session' | 'relay'
  status: 'done'
  /** session name (type=session) or relay loopId (type=relay). */
  id: string
  /** transcript byte cursor at completion. */
  cursor: number
  /** short human summary of what finished. */
  summary: string
  /** relay end reason, when applicable. */
  reason?: string
  /**
   * A client-neutral, copy-pasteable handoff block (plain text, multi-line).
   * Pasting it into any capable agent or chat tells it what finished and what
   * to check next. Computed by emitCompletion; absent on escalation and
   * needs-input events.
   */
  handoff?: string
}

/** Git facts for the handoff block; both fall back to safe strings. */
interface GitInfo {
  commit: string
  filesChanged: string
}

/**
 * Best-effort, bounded git facts for the handoff. If `cwd` is a git repo, read
 * the short HEAD hash and the count of files changed in the last commit. Each
 * command is wrapped in try/catch with a hard 3s timeout and stderr silenced, so
 * a missing git binary, a non-repo cwd, or a slow filesystem can never crash or
 * hang the emit path — it just falls back ("none" / "unknown").
 */
function gitInfo(cwd?: string): GitInfo {
  const fallback: GitInfo = { commit: 'none', filesChanged: 'unknown' }
  if (!cwd) return fallback
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  let commit = 'none'
  try {
    commit = run(['rev-parse', '--short', 'HEAD']) || 'none'
  } catch {
    return fallback // not a repo / no git — give up on both, stay fast.
  }
  let filesChanged = 'unknown'
  try {
    // --shortstat yields e.g. " 3 files changed, 40 insertions(+), 2 deletions(-)".
    const stat = run(['diff', '--stat', 'HEAD~1', '--shortstat'])
    const m = stat.match(/(\d+)\s+files?\s+changed/)
    if (m) filesChanged = m[1]
  } catch {
    /* keep "unknown" */
  }
  return { commit, filesChanged }
}

/**
 * Build a client-neutral handoff block for any capable agent, chat, or
 * automation consuming Tandem's completion event.
 */
export function buildHandoff(event: { id: string; status: string; summary: string }, git: GitInfo): string {
  return [
    `Tandem check: session "${event.id}" finished (${event.status}).`,
    `Summary: ${event.summary}`,
    `Commit: ${git.commit}`,
    `Files changed: ${git.filesChanged}`,
    `Next: Review the session output and decide the next step.`,
  ].join('\n')
}

/** Collapse whitespace and clamp to a short single-line summary. */
export function summarize(s: string, max = 200): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > max ? t.slice(0, max - 3) + '...' : t
}

/** A ready-to-send ntfy notification (pure; no I/O — unit-testable). */
export interface NtfyPayload {
  title: string
  body: string
  priority: string
  tags: string
  /** Optional ntfy Click URL — tapping the notification opens this on the phone. */
  click?: string
}

interface NtfyPayloadOptions {
  escalation?: boolean
  needsInput?: boolean
  reason?: string
  clickUrl?: string
}

function safeClickUrl(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Build the ntfy notification for an event. A normal completion is a quiet
 * "<id> done"; an escalation (the manager is stuck and needs the human) is an
 * URGENT "<id> NEEDS YOU" carrying the blocking reason, so the two are
 * unmistakable on the phone. Pure: returns the payload, sends nothing.
 */
export function ntfyPayload(
  event: CompletionEvent,
  opts?: NtfyPayloadOptions,
): NtfyPayload {
  const click = safeClickUrl(opts?.clickUrl)
  if (opts?.needsInput) {
    // Non-terminal question: the manager is alive and waiting for an answer.
    // Distinct title from both 'done' and the terminal BLOCKED 'NEEDS YOU'.
    const reason = (opts.reason ?? event.reason ?? event.summary ?? '').trim()
    return {
      title: `tandem: ${event.id} NEEDS YOUR ANSWER`,
      body: summarize(`${event.type} ${event.id} asked: ${reason || 'needs your answer'}`),
      priority: 'urgent',
      tags: 'question,speech_balloon',
      ...(click ? { click } : {}),
    }
  }
  if (opts?.escalation) {
    const reason = (opts.reason ?? event.reason ?? event.summary ?? '').trim()
    return {
      title: `tandem: ${event.id} NEEDS YOU`,
      body: summarize(`${event.type} ${event.id} is BLOCKED: ${reason || 'needs your input'}`),
      priority: 'urgent',
      tags: 'warning,sos',
      ...(click ? { click } : {}),
    }
  }
  return {
    // Short title; the BODY is the chat-ready handoff block (multi-line, NOT
    // collapsed) so you can copy it straight from the notification into a chat.
    // Falls back to the old one-line summary if no handoff was computed.
    title: `tandem: ${event.id} done`,
    body: event.handoff ?? summarize(`${event.type} ${event.id} ${event.status} @${event.cursor}: ${event.summary}`),
    priority: 'default',
    tags: 'white_check_mark',
    ...(click ? { click } : {}),
  }
}

/**
 * Push a phone notification via ntfy (https://ntfy.sh or self-hosted). Disabled
 * unless TANDEM_NTFY_TOPIC is set. Fire-and-forget: a network failure is caught
 * and logged to ~/.tandem/bridge.log, never crashing or blocking the bridge.
 *
 * NOTE: this reaches a DEVICE (your phone/the ntfy app), not the chat client.
 */
function notifyNtfy(event: CompletionEvent, opts?: NtfyPayloadOptions): void {
  const topic = process.env.TANDEM_NTFY_TOPIC
  if (!topic) return // ntfy off unless a topic is configured

  const server = (process.env.TANDEM_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')
  const url = `${server}/${encodeURIComponent(topic)}`
  const { title, body, priority, tags, click } = ntfyPayload(event, {
    ...opts,
    clickUrl: process.env.TANDEM_NTFY_CLICK_URL,
  })

  try {
    void fetch(url, {
      method: 'POST',
      // Headers must be ASCII/single-line; the id matches NAME_RE so this is safe.
      // Click (if present) is a plain URL — also single-line ASCII.
      headers: { Title: title, Priority: priority, Tags: tags, ...(click ? { Click: click } : {}) },
      body,
    }).catch((e) => logBridge({ event: 'ntfy', ok: false, error: String(e) }))
  } catch (e) {
    logBridge({ event: 'ntfy', ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Emit a completion event. Never throws and never blocks the caller: log-write
 * failures go to stderr and the webhook POST is fire-and-forget.
 */
export function emitCompletion(
  ev: Omit<CompletionEvent, 'status' | 'ts' | 'handoff'> & {
    silent?: boolean
    cwd?: string
    turn: EmitTurn
    /** `completed` (a turn finished) unless the caller says otherwise; the
     *  relay's own shutdown reports `closed`. */
    foremanKind?: Extract<ForemanEventKind, 'completed' | 'closed'>
  },
): void {
  // `silent` suppresses ONLY the phone push (sink 3) — events.log + webhook still
  // fire — so routine per-task completions stay durable without buzzing the phone.
  // `cwd` is used only to compute the git facts in the handoff; it is NOT stored
  // in the event (so no local path leaks into events.log / the webhook).
  const { silent, cwd, turn, foremanKind, ...rest } = ev
  const base = { ts: new Date().toISOString(), status: 'done' as const, ...rest }
  // Chat-ready handoff block, computed once and carried on the event so all three
  // sinks (log line, webhook JSON, ntfy body) share the same text.
  const handoff = buildHandoff(base, gitInfo(cwd))
  const event = { ...base, handoff }
  const line = JSON.stringify(event) + '\n'

  // 1) Durable local log.
  try {
    appendEventLine(line)
  } catch {
    process.stderr.write('[events] event log write failed\n')
  }

  // 2) Optional outbound webhook.
  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => logBridge({ event: 'webhook', ok: false, error: String(e) }))
    } catch (e) {
      logBridge({ event: 'webhook', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 3) Optional phone push via ntfy (env-gated, fire-and-forget) — unless silent.
  if (!silent) notifyNtfy(event)

  // 4) Durable, redacted, bounded projection for a returning foreman. NOTE the
  //    handoff block and `cwd` are deliberately NOT passed on: they carry git
  //    facts and a local path, and this store is readable by the MCP client.
  recordForeman(foremanKind ?? 'completed', rest, turn)
}

/**
 * Emit a NEEDS-INPUT event (Phase 6c): the manager asked the human a question and
 * is parked ALIVE awaiting the answer (NOT torn down). Same sinks as
 * emitCompletion, but the log line is tagged `event:"needs_input"` and the ntfy
 * push is URGENT with a distinct "NEEDS YOUR ANSWER" title carrying the question.
 * Never throws/blocks.
 */
export function emitNeedsInput(ev: Omit<CompletionEvent, 'status'> & { reason: string; turn: EmitTurn }): void {
  const { turn, ...rest } = ev
  const event = { ts: new Date().toISOString(), status: 'done' as const, ...rest }
  const line = JSON.stringify({ event: 'needs_input', ...event }) + '\n'

  try {
    appendEventLine(line)
  } catch {
    process.stderr.write('[events] needs_input log write failed\n')
  }

  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => logBridge({ event: 'webhook', ok: false, error: String(e) }))
    } catch (e) {
      logBridge({ event: 'webhook', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  notifyNtfy(event, { needsInput: true, reason: ev.reason })
  recordForeman('needs_input', rest, turn)
}

/**
 * Emit an ESCALATION: the manager is stuck and needs the human. Same sinks as
 * emitCompletion (durable log + ntfy), but the log line is tagged
 * `event:"escalation"` and the ntfy push is URGENT and carries the blocking
 * reason. This is the one place a device-push is the right primitive: the human
 * is the only node at the top that can actually be woken. Never throws/blocks.
 */
export function emitEscalation(ev: Omit<CompletionEvent, 'status'> & { reason: string; turn: EmitTurn }): void {
  const { turn, ...rest } = ev
  const event = { ts: new Date().toISOString(), status: 'done' as const, ...rest }
  const line = JSON.stringify({ event: 'escalation', ...event }) + '\n'

  // 1) Durable local log (tagged so watchers can distinguish from completions).
  try {
    appendEventLine(line)
  } catch {
    process.stderr.write('[events] escalation log write failed\n')
  }

  // 2) Optional outbound webhook (same raw JSON line).
  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => logBridge({ event: 'webhook', ok: false, error: String(e) }))
    } catch (e) {
      logBridge({ event: 'webhook', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 3) Urgent phone push via ntfy (env-gated, fire-and-forget).
  notifyNtfy(event, { escalation: true, reason: ev.reason })
  recordForeman('blocked', rest, turn)
}

/**
 * Emit a non-completion lifecycle transition: a turn the foreman interrupted, a
 * session it closed, or a send that failed outright.
 *
 * These are foreman-facing bookkeeping, not "your work is ready" news, so they
 * take the durable sinks (events.log + the foreman inbox) but deliberately do
 * NOT buzz a phone: the person who pressed interrupt or close already knows,
 * and an error is surfaced to the caller synchronously as a 500. Never
 * throws/blocks.
 */
export function emitLifecycle(
  ev: {
    type: 'session' | 'relay'
    id: string
    kind: Extract<ForemanEventKind, 'interrupted' | 'closed' | 'error'>
    cursor?: number
    summary?: string
    reason?: string
    turn: EmitTurn
  },
): void {
  const { turn, kind, ...rest } = ev
  const line = JSON.stringify({ event: kind, ts: new Date().toISOString(), ...rest }) + '\n'

  try {
    appendEventLine(line)
  } catch {
    process.stderr.write('[events] lifecycle log write failed\n')
  }

  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => logBridge({ event: 'webhook', ok: false, error: String(e) }))
    } catch (e) {
      logBridge({ event: 'webhook', ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  recordForeman(kind, rest, turn)
}
