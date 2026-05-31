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
 * The MCP connection itself cannot reliably carry a server-initiated wake-up in
 * the current stateless Streamable-HTTP setup — see the README "Completion
 * events / waking the client" section for what a client would need to do.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const EVENTS_DIR = join(homedir(), '.tandem')
const EVENTS_LOG = join(EVENTS_DIR, 'events.log')
const BRIDGE_LOG = join(EVENTS_DIR, 'bridge.log')

/** Append a structured line to ~/.tandem/bridge.log; never throws. */
function logBridge(fields: Record<string, unknown>): void {
  try {
    mkdirSync(EVENTS_DIR, { recursive: true })
    appendFileSync(BRIDGE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n')
  } catch (e) {
    process.stderr.write(`[events] bridge.log write failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
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
}

/**
 * Build the ntfy notification for an event. A normal completion is a quiet
 * "<id> done"; an escalation (the manager is stuck and needs the human) is an
 * URGENT "<id> NEEDS YOU" carrying the blocking reason, so the two are
 * unmistakable on the phone. Pure: returns the payload, sends nothing.
 */
export function ntfyPayload(
  event: CompletionEvent,
  opts?: { escalation?: boolean; reason?: string },
): NtfyPayload {
  if (opts?.escalation) {
    const reason = (opts.reason ?? event.reason ?? event.summary ?? '').trim()
    return {
      title: `tandem: ${event.id} NEEDS YOU`,
      body: summarize(`${event.type} ${event.id} is BLOCKED — ${reason || 'needs your input'}`),
      priority: 'urgent',
      tags: 'warning,sos',
    }
  }
  return {
    // One-line human summary: id, status, cursor, then the short summary text.
    title: `tandem: ${event.id} done`,
    body: summarize(`${event.type} ${event.id} ${event.status} @${event.cursor} — ${event.summary}`),
    priority: 'default',
    tags: 'white_check_mark',
  }
}

/**
 * Push a phone notification via ntfy (https://ntfy.sh or self-hosted). Disabled
 * unless TANDEM_NTFY_TOPIC is set. Fire-and-forget: a network failure is caught
 * and logged to ~/.tandem/bridge.log, never crashing or blocking the bridge.
 *
 * NOTE: this reaches a DEVICE (your phone/the ntfy app), not the chat client.
 */
function notifyNtfy(event: CompletionEvent, opts?: { escalation?: boolean; reason?: string }): void {
  const topic = process.env.TANDEM_NTFY_TOPIC
  if (!topic) return // ntfy off unless a topic is configured

  const server = (process.env.TANDEM_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')
  const url = `${server}/${encodeURIComponent(topic)}`
  const { title, body, priority, tags } = ntfyPayload(event, opts)

  try {
    void fetch(url, {
      method: 'POST',
      // Headers must be ASCII/single-line; the id matches NAME_RE so this is safe.
      headers: { Title: title, Priority: priority, Tags: tags },
      body,
    }).catch((e) => logBridge({ event: 'ntfy', ok: false, topic, error: String(e) }))
  } catch (e) {
    logBridge({ event: 'ntfy', ok: false, topic, error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Emit a completion event. Never throws and never blocks the caller: log-write
 * failures go to stderr and the webhook POST is fire-and-forget.
 */
export function emitCompletion(ev: Omit<CompletionEvent, 'status' | 'ts'>): void {
  const event = { ts: new Date().toISOString(), status: 'done' as const, ...ev }
  const line = JSON.stringify(event) + '\n'

  // 1) Durable local log.
  try {
    mkdirSync(EVENTS_DIR, { recursive: true })
    appendFileSync(EVENTS_LOG, line)
  } catch (e) {
    process.stderr.write(`[events] log write failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }

  // 2) Optional outbound webhook.
  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => process.stderr.write(`[events] webhook POST failed: ${e}\n`))
    } catch (e) {
      process.stderr.write(`[events] webhook error: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  // 3) Optional phone push via ntfy (env-gated, fire-and-forget).
  notifyNtfy(event)
}

/**
 * Emit an ESCALATION: the manager is stuck and needs the human. Same sinks as
 * emitCompletion (durable log + ntfy), but the log line is tagged
 * `event:"escalation"` and the ntfy push is URGENT and carries the blocking
 * reason. This is the one place a device-push is the right primitive: the human
 * is the only node at the top that can actually be woken. Never throws/blocks.
 */
export function emitEscalation(ev: Omit<CompletionEvent, 'status'> & { reason: string }): void {
  const event = { ts: new Date().toISOString(), status: 'done' as const, ...ev }
  const line = JSON.stringify({ event: 'escalation', ...event }) + '\n'

  // 1) Durable local log (tagged so watchers can distinguish from completions).
  try {
    mkdirSync(EVENTS_DIR, { recursive: true })
    appendFileSync(EVENTS_LOG, line)
  } catch (e) {
    process.stderr.write(`[events] escalation log write failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }

  // 2) Optional outbound webhook (same raw JSON line).
  const url = process.env.TANDEM_DONE_WEBHOOK
  if (url) {
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      }).catch((e) => process.stderr.write(`[events] webhook POST failed: ${e}\n`))
    } catch (e) {
      process.stderr.write(`[events] webhook error: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  // 3) Urgent phone push via ntfy (env-gated, fire-and-forget).
  notifyNtfy(event, { escalation: true, reason: ev.reason })
}
