/**
 * bridge/relay.ts — the ZERO-API peer-to-peer relay (replaces the removed API brain).
 *
 * Connects TWO interactive tmux-hosted Claude Code sessions, both billed against
 * Max's real interactive subscription (NEVER the Messages API — there is no
 * @anthropic-ai/sdk here, and we never set ANTHROPIC_API_KEY):
 *
 *   - the LEAD ("brain") session, seeded as the reviewer/strategist. Each round
 *     it emits ONE concrete instruction for the worker (or the DONE sentinel).
 *   - the WORKER session, which does the hands-on work and reports back.
 *
 * Both are TerminalSession instances driven through the SHARED INTERFACE CONTRACT
 * (./terminal-session). The relay owns the conversation: lead.send -> worker.send
 * -> feed the worker report back to the lead as the next message, until the lead
 * says DONE, maxTurns is hit, the wall-clock deadline passes, or stop() is called.
 *
 * SAFETY (prior review flagged these):
 *   - maxTurns is a HARD ceiling clamp (default 24, client values above
 *     MAX_TURNS_CEILING are ignored).
 *   - a wall-clock cap (default 30min) is CHECKED DURING awaits: every send() is
 *     raced against the loop deadline, not merely checked between turns, so a
 *     single hung turn can never blow past the budget. On deadline (or stop) the
 *     active session is interrupt()'d so it stops promptly.
 *   - robust DONE detection: case-insensitive "DONE" on its own line, tolerating
 *     surrounding markdown / trailing punctuation.
 *   - stop()/inject() take effect promptly — stop() flips the running flag AND
 *     interrupts both sessions; inject() rewrites the next lead input.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TerminalSession } from './terminal-session.ts'

const HOME = homedir()
const RELAY_DIR = join(HOME, 'cloud-code-mcp', 'relay')

/** Defaults + hard ceilings. Client-supplied values are clamped to these. */
const DEFAULT_MAX_TURNS = 24
const MAX_TURNS_CEILING = 50
const DEFAULT_WALL_CLOCK_MS = 30 * 60_000 // 30 minutes

/** The seed that turns the lead session into the strategist/reviewer. */
function leadSeed(goal: string, context?: string): string {
  const spec = context && context.trim() ? `\n\nRelevant spec / context:\n${context.trim()}\n` : ''
  return [
    'You drive a SECOND Claude Code session (the "worker") to achieve a goal.',
    'You are the lead/strategist and reviewer. You do NOT touch files yourself —',
    'the worker does the hands-on work. Each turn, reply with ONE concrete,',
    'self-contained instruction for the worker (it has no memory of this',
    'conversation, so include any needed context in the instruction). After the',
    'worker reports back, review its work against the goal and either give the',
    'next single instruction, or — when the goal is fully achieved — output DONE',
    'on a line by itself. Keep instructions short and actionable.',
    spec,
    `\nGOAL: ${goal}`,
    '\nReply now with your FIRST instruction for the worker.',
  ].join('\n')
}

/** How a worker report is wrapped before being fed back to the lead. */
function wrapWorkerReport(report: string): string {
  return [
    'The worker session ran your instruction and reported back:',
    '"""',
    report.trim(),
    '"""',
    'Review this against the GOAL. Reply with the next single instruction for the',
    'worker, or output DONE on its own line if the goal is now fully achieved.',
  ].join('\n')
}

/**
 * DONE detection. Accepts a "DONE" sentinel on its own line, case-insensitive,
 * tolerating surrounding markdown and trailing punctuation. Examples that match:
 *   DONE            done.           **DONE**          > DONE!
 *   - done          ## DONE         `DONE`            DONE:
 * We deliberately require it on its OWN line so the word "done" inside a normal
 * sentence ("almost done with step 2") does NOT trip the sentinel.
 */
export function isDone(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip leading markdown bullets/quotes/heading marks and surrounding
    // emphasis/backtick/whitespace, then any trailing punctuation.
    const line = rawLine
      .replace(/^\s*(?:[>*\-+#]\s*)*/, '') // leading markers
      .replace(/^[*_`"'(\[\s]+/, '') // leading emphasis/quote/bracket
      .replace(/[*_`"')\].!?:;,\s]+$/, '') // trailing emphasis/punct
      .trim()
    if (line.toUpperCase() === 'DONE') return true
  }
  return false
}

/** A single running relay loop. */
interface RelayLoop {
  loopId: string
  leadName: string
  workerName: string
  lead: TerminalSession
  worker: TerminalSession
  logPath: string
  running: boolean
  /** Set by inject(): overrides the next message fed to the lead. */
  pendingInjection?: string
  /** The session currently inside an awaited send(), so stop() can interrupt it. */
  active?: TerminalSession
  /** Absolute wall-clock deadline (ms epoch). */
  deadline: number
  finished: Promise<void>
}

const loops = new Map<string, RelayLoop>()

function ensureRelayDir(): void {
  mkdirSync(RELAY_DIR, { recursive: true })
}

/** Append a tagged line to the dual transcript. The byte length is the cursor. */
function transcript(loop: RelayLoop, tag: 'LEAD' | 'WORKER' | 'SYS', text: string): void {
  const block = `\n[${tag}] ${new Date().toISOString()}\n${text.trimEnd()}\n`
  try {
    appendFileSync(loop.logPath, block)
  } catch (e) {
    // Surface — do not silently swallow (mirrors the bridge audit-log rule).
    process.stderr.write(
      `[relay] transcript write failed for ${loop.loopId}: ${e instanceof Error ? e.message : String(e)}\n`,
    )
  }
  // Also render live to stdout so Max watching the bridge sees both sides talk.
  process.stdout.write(block)
}

export interface StartRelayOptions {
  goal: string
  cwd: string
  /** Clamped to [1, MAX_TURNS_CEILING]; defaults to DEFAULT_MAX_TURNS. */
  maxTurns?: number
  /** Optional wall-clock cap override (ms); clamped to <= DEFAULT_WALL_CLOCK_MS. */
  wallClockMs?: number
  /** Spec/context text seeded into the lead. */
  context?: string
  /** cwd allowlist passed straight through to TerminalSession.spawn. */
  allowlist?: string[]
}

export interface StartRelayResult {
  loopId: string
  leadName: string
  workerName: string
}

/** Clamp a possibly-untrusted turn count to the safe hard ceiling. */
function clampMaxTurns(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_TURNS
  const n = Math.floor(requested)
  if (n < 1) return DEFAULT_MAX_TURNS
  return Math.min(n, MAX_TURNS_CEILING)
}

/**
 * Spawn the two sessions, seed the lead, and kick off the loop in the
 * BACKGROUND. Returns immediately with the ids so the caller (bridge router)
 * never blocks the tunnel; progress is observed via readSince().
 */
export async function startRelay(opts: StartRelayOptions): Promise<StartRelayResult> {
  ensureRelayDir()
  const loopId = randomUUID().slice(0, 8)
  const maxTurns = clampMaxTurns(opts.maxTurns)
  const wallClockMs = Math.min(
    opts.wallClockMs && opts.wallClockMs > 0 ? opts.wallClockMs : DEFAULT_WALL_CLOCK_MS,
    DEFAULT_WALL_CLOCK_MS,
  )

  const leadName = `relay-${loopId}-lead`
  const workerName = `relay-${loopId}-worker`

  // The bridge always passes a built allowlist; default to an empty list (which
  // makes spawn reject every cwd) if a caller omits it, so the type contract is
  // satisfied and an unguarded call can never spawn outside the boundary.
  const allowlist = opts.allowlist ?? []

  // Spawn both interactive sessions. cwd is validated against the allowlist
  // INSIDE TerminalSession.spawn (per the shared contract).
  const lead = await TerminalSession.spawn({ name: leadName, cwd: opts.cwd, allowlist })
  let worker: TerminalSession
  try {
    worker = await TerminalSession.spawn({ name: workerName, cwd: opts.cwd, allowlist })
  } catch (e) {
    // Don't leak the lead session if the worker fails to come up.
    await lead.close().catch(() => {})
    throw e
  }

  const loop: RelayLoop = {
    loopId,
    leadName: lead.name,
    workerName: worker.name,
    lead,
    worker,
    logPath: join(RELAY_DIR, `${loopId}.log`),
    running: true,
    deadline: Date.now() + wallClockMs,
    finished: Promise.resolve(),
  }
  loops.set(loopId, loop)

  transcript(loop, 'SYS', `relay started · goal: ${opts.goal}\ncwd: ${opts.cwd}\nmaxTurns: ${maxTurns} · wallClock: ${Math.round(wallClockMs / 60_000)}min`)
  transcript(loop, 'SYS', `attach lead:   ${lead.attachHint()}\nattach worker: ${worker.attachHint()}`)

  loop.finished = runLoop(loop, opts.goal, opts.context, maxTurns)

  return { loopId, leadName: lead.name, workerName: worker.name }
}

/**
 * Race a session.send() against the loop deadline AND the running flag. If the
 * deadline passes (or stop() flips running) while we are awaiting, we interrupt
 * the active session so it stops promptly and resolve with a timeout marker —
 * the wall-clock / stop budget is therefore enforced DURING the await, not only
 * between turns.
 */
async function sendRaced(
  loop: RelayLoop,
  session: TerminalSession,
  text: string,
): Promise<
  | { kind: 'report'; report: string }
  | { kind: 'deadline' }
  | { kind: 'stopped' }
> {
  loop.active = session
  let watchdog: ReturnType<typeof setInterval> | undefined
  try {
    const sendP = session.send(text).then(
      (r: { report: string }) => ({ kind: 'report' as const, report: r.report }),
      (e: unknown) => ({ kind: 'report' as const, report: `(session error: ${e instanceof Error ? e.message : String(e)})` }),
    )
    const guard = new Promise<{ kind: 'deadline' } | { kind: 'stopped' }>((res) => {
      watchdog = setInterval(() => {
        if (!loop.running) {
          res({ kind: 'stopped' })
        } else if (Date.now() >= loop.deadline) {
          res({ kind: 'deadline' })
        }
      }, 500)
    })
    const winner = await Promise.race([sendP, guard])
    if (winner.kind !== 'report') {
      // We are abandoning this turn — stop the runaway TUI turn promptly.
      await session.interrupt().catch(() => {})
    }
    return winner
  } finally {
    if (watchdog) clearInterval(watchdog)
    loop.active = undefined
  }
}

/** The autonomous lead<->worker loop. Runs in the background; never throws. */
async function runLoop(
  loop: RelayLoop,
  goal: string,
  context: string | undefined,
  maxTurns: number,
): Promise<void> {
  let nextLeadMessage = leadSeed(goal, context)
  let endReason = 'completed'

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (!loop.running) {
        endReason = 'stopped'
        break
      }
      if (Date.now() >= loop.deadline) {
        endReason = 'wall-clock cap reached'
        break
      }

      // An inject() takes precedence as the next thing the lead hears.
      if (loop.pendingInjection !== undefined) {
        nextLeadMessage = `Operator injected a message: ${loop.pendingInjection}\n\n${nextLeadMessage}`
        loop.pendingInjection = undefined
      }

      // --- LEAD turn: produce one instruction (or DONE) ---
      transcript(loop, 'SYS', `--- turn ${turn}/${maxTurns} ---`)
      const leadRes = await sendRaced(loop, loop.lead, nextLeadMessage)
      if (leadRes.kind === 'deadline') {
        endReason = 'wall-clock cap reached'
        break
      }
      if (leadRes.kind === 'stopped') {
        endReason = 'stopped'
        break
      }
      const leadInstruction = leadRes.report
      transcript(loop, 'LEAD', leadInstruction)

      if (isDone(leadInstruction)) {
        endReason = 'lead reported DONE'
        break
      }

      if (!loop.running) {
        endReason = 'stopped'
        break
      }

      // --- WORKER turn: carry out the instruction, report back ---
      const workerRes = await sendRaced(loop, loop.worker, leadInstruction)
      if (workerRes.kind === 'deadline') {
        endReason = 'wall-clock cap reached'
        break
      }
      if (workerRes.kind === 'stopped') {
        endReason = 'stopped'
        break
      }
      transcript(loop, 'WORKER', workerRes.report)

      // Feed the worker's report back to the lead for the next round.
      nextLeadMessage = wrapWorkerReport(workerRes.report)

      if (turn === maxTurns) endReason = 'max turns reached'
    }
  } catch (e) {
    endReason = `loop error: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    loop.running = false
    transcript(loop, 'SYS', `relay finished · reason: ${endReason}`)
    // Tear the tmux sessions down so they don't linger.
    await loop.lead.close().catch(() => {})
    await loop.worker.close().catch(() => {})
  }
}

/** Page the dual transcript from a byte cursor. Returns undefined for unknown loopId. */
export function readSince(
  loopId: string,
  cursor = 0,
): { text: string; cursor: number; running: boolean } | undefined {
  const loop = loops.get(loopId)
  if (!loop) return undefined
  let size = 0
  try {
    size = statSync(loop.logPath).size
  } catch {
    return { text: '', cursor: 0, running: loop.running }
  }
  const from = Math.max(0, Math.min(cursor, size))
  let text = ''
  if (size > from) {
    try {
      const buf = readFileSync(loop.logPath)
      text = buf.subarray(from, size).toString('utf8')
    } catch {
      text = ''
    }
  }
  return { text, cursor: size, running: loop.running }
}

/**
 * Stop a loop PROMPTLY: flip the running flag (so the loop body bails at its next
 * guard) AND interrupt the session currently mid-send (so a long-running TUI turn
 * doesn't have to finish first). Idempotent.
 */
export function stop(loopId: string): { ok: boolean; running: boolean } {
  const loop = loops.get(loopId)
  if (!loop) return { ok: false, running: false }
  loop.running = false
  // Interrupt whatever is mid-await right now, plus both sessions defensively.
  const active = loop.active
  if (active) void active.interrupt().catch(() => {})
  void loop.lead.interrupt().catch(() => {})
  void loop.worker.interrupt().catch(() => {})
  return { ok: true, running: false }
}

/**
 * Inject an operator message into the loop. It is prepended to the next message
 * the lead receives (taking effect on the next round, promptly — the loop checks
 * pendingInjection at the top of every turn). Returns whether it was accepted.
 */
export function inject(loopId: string, message: string): { ok: boolean } {
  const loop = loops.get(loopId)
  if (!loop || !loop.running) return { ok: false }
  loop.pendingInjection = message
  transcript(loop, 'SYS', `operator injected: ${message}`)
  return { ok: true }
}

/** Loop metadata (for status / list surfaces). undefined if unknown. */
export function info(
  loopId: string,
): { loopId: string; leadName: string; workerName: string; running: boolean } | undefined {
  const loop = loops.get(loopId)
  if (!loop) return undefined
  return { loopId: loop.loopId, leadName: loop.leadName, workerName: loop.workerName, running: loop.running }
}
