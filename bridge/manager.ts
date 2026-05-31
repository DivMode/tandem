/**
 * manager.ts — the disk-backed memory layer for a persistent relay "manager".
 *
 * The relay's lead session is a real OS process, but its working memory today is
 * a single rolling string held in the bridge process (relay.ts `nextLeadMessage`)
 * plus whatever survives the lead's own context window — both volatile. This
 * module gives the manager a real mind on disk so it is RESUMABLE across context
 * compaction and bridge restarts: continuity comes from re-reading files, not
 * from a process "staying alive".
 *
 * Three files per manager, under ~/.tandem/manager/<loopId>/:
 *   MISSION.md   — the standing definition of "done". Written once, re-read each turn.
 *   STATE.json   — the working set: status / turn / current task / blocked reason.
 *   LOG.md       — append-only decision log, one line per turn. The durable memory.
 *
 * All write/read helpers take an explicit `dir` (no hidden global) so they are
 * unit-testable against a tmp dir, and they never throw — a broken memory file
 * must not take down the relay loop.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MANAGER_ROOT = join(homedir(), '.tandem', 'manager')

/** The manager's working set, persisted to STATE.json. */
export interface ManagerState {
  status: 'running' | 'blocked' | 'done'
  /** last completed lead turn. */
  turn: number
  /** short description of the current task/focus. */
  task: string
  /** set when status === 'blocked'; the reason to surface to the human. */
  blockedReason?: string
  /** ISO timestamp of the last write. */
  updatedTs: string
}

/** Absolute memory dir for a given relay loopId. */
export function managerDir(loopId: string): string {
  return join(MANAGER_ROOT, loopId)
}

/**
 * Detect the escalation sentinel. The lead emits `BLOCKED: <reason>` (on its own
 * line) when it cannot proceed without the human — mirrors isDone()'s tolerant,
 * own-line matching so the word "blocked" inside a sentence never trips it.
 * Returns the reason (possibly '' for a bare BLOCKED), or null if not present.
 */
export function parseBlocked(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*(?:[>*\-+#]\s*)*/, '') // leading markdown bullets/quotes/headings
      .replace(/^[*_`"'(\[\s]+/, '') // leading emphasis/quote/bracket
      .trim()
    const m = /^blocked\b[*_`"'\s]*[:\-—]?\s*(.*)$/i.exec(line)
    if (m) {
      // Strip any trailing emphasis/punctuation noise from the captured reason.
      return m[1].replace(/[*_`"')\]\s]+$/, '').trim()
    }
  }
  return null
}

function statePath(dir: string): string {
  return join(dir, 'STATE.json')
}
function missionPath(dir: string): string {
  return join(dir, 'MISSION.md')
}
function logPath(dir: string): string {
  return join(dir, 'LOG.md')
}

/** Seed the three memory files for a fresh manager. Never throws. */
export function initManagerMemory(dir: string, opts: { goal: string; context?: string }): void {
  try {
    mkdirSync(dir, { recursive: true })
    const ctx = opts.context && opts.context.trim() ? `\n\n## Context / spec\n\n${opts.context.trim()}\n` : ''
    writeFileSync(missionPath(dir), `# Mission\n\n${opts.goal.trim()}\n${ctx}`)
    const state: ManagerState = {
      status: 'running',
      turn: 0,
      task: 'initializing',
      updatedTs: new Date().toISOString(),
    }
    writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + '\n')
    appendFileSync(logPath(dir), `# Decision log\n\n[${state.updatedTs}] manager started\n`)
  } catch (e) {
    process.stderr.write(`[manager] init failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

/** Append one decision line to LOG.md. Never throws. */
export function appendDecision(dir: string, entry: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(logPath(dir), `[${new Date().toISOString()}] ${entry.trim()}\n`)
  } catch (e) {
    process.stderr.write(`[manager] log append failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

/** Read+merge+write STATE.json. Returns the new state. Never throws. */
export function updateState(dir: string, patch: Partial<ManagerState>): ManagerState {
  const current = readMemory(dir).state ?? {
    status: 'running' as const,
    turn: 0,
    task: 'initializing',
    updatedTs: new Date().toISOString(),
  }
  const next: ManagerState = { ...current, ...patch, updatedTs: new Date().toISOString() }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(statePath(dir), JSON.stringify(next, null, 2) + '\n')
  } catch (e) {
    process.stderr.write(`[manager] state write failed: ${e instanceof Error ? e.message : String(e)}\n`)
  }
  return next
}

/** Read the manager's memory. Missing/corrupt files degrade gracefully. */
export function readMemory(dir: string): {
  mission: string
  state: ManagerState | null
  logTail: string
} {
  let mission = ''
  try {
    mission = readFileSync(missionPath(dir), 'utf8')
  } catch {
    /* no mission yet */
  }
  let state: ManagerState | null = null
  try {
    state = JSON.parse(readFileSync(statePath(dir), 'utf8')) as ManagerState
  } catch {
    /* no/corrupt state */
  }
  let logTail = ''
  try {
    logTail = tailLines(readFileSync(logPath(dir), 'utf8'), 40)
  } catch {
    /* no log yet */
  }
  return { mission, state, logTail }
}

/** Last `n` non-empty-trimmed lines of a text blob. */
function tailLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/**
 * Build the re-grounding preamble prepended to the lead each turn: the mission
 * plus the recent decision log. This is what makes the manager resumable — even
 * after a context compaction the lead re-reads what it is doing and what it has
 * already decided. Returns '' when there is no memory yet.
 */
export function regroundPreamble(dir: string, maxLogLines = 20): string {
  const { mission, logTail } = readMemory(dir)
  if (!mission && !logTail) return ''
  const recent = tailLines(logTail, maxLogLines)
  return [
    '=== STANDING MEMORY (re-read every turn — your real state lives on disk) ===',
    mission.trim(),
    '',
    'Recent decisions (append-only log):',
    recent.trim() || '(none yet)',
    '',
    'If you cannot proceed without the human (repeated worker failure, a call that',
    'needs their authority/taste, or an irreversible action), reply with',
    '"BLOCKED: <reason>" on its own line and STOP — that pings them directly.',
    '=== END STANDING MEMORY ===',
    '',
  ].join('\n')
}
