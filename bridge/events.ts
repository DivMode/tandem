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
}
