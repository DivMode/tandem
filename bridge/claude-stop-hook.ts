/**
 * claude-stop-hook.ts — the Claude `Stop` / `StopFailure` hook, as a library.
 *
 * Claude Code runs a command hook in its own process at a turn boundary and
 * writes a small JSON object to its stdin. This module is the whole of what
 * that process does: parse, validate, clamp, deposit into
 * ./claude-lifecycle-store.ts, exit. src/claude-stop-hook.ts is a thin
 * stdin/exit wrapper around `handleClaudeStopHook` so all of the behaviour
 * below is testable without spawning anything.
 *
 * THE ONE RULE: NEVER BREAK CLAUDE. A hook is in the critical path of a real
 * user's session. Whatever happens — malformed JSON, an unwritable state
 * directory, a payload from a future Claude version, an object that is not a
 * hook payload at all — this returns an ignorable result with exit code 0 and
 * an empty stdout. There is no input that makes it throw and no input that
 * makes it exit non-zero. A lost lifecycle record costs Tandem one reporting
 * signal; a failing hook costs the user their worker.
 *
 * That rule is also why validation is total rather than schematic. Nothing here
 * assumes a field exists because the documented payload has it: `Stop` carries
 * `last_assistant_message` and `StopFailure` does not, and a future Claude may
 * add, rename, or drop fields freely. Anything unrecognised is ignored, not
 * rejected.
 *
 * WHAT IS READ, AND WHAT IS POINTEDLY NOT. Read: `hook_event_name` (which
 * boundary), `session_id` (Claude's own opaque id), and — on `Stop` only —
 * `last_assistant_message`. Ignored entirely: `cwd` and `transcript_path`. Both
 * are absolute local filesystem locations and the transcript additionally names
 * a file containing the full conversation. They are never read, never followed,
 * and never stored, so no amount of downstream leakage can expose them from
 * this path. `stop_hook_active` is ignored too: this hook never blocks a stop,
 * so the re-entrancy flag it exists to guard has nothing to guard here.
 *
 * SILENT BY DESIGN. stdout is always empty. Claude surfaces hook stdout to the
 * user (and, on some events, to the model), and the only things this process
 * knows are a session identity and a fragment of assistant output — exactly the
 * material that must not be echoed. Diagnostics are opt-in via
 * TANDEM_CLAUDE_HOOK_DEBUG and carry an outcome word and nothing else.
 */
import {
  ClaudeLifecycleStore,
  defaultClaudeLifecycleStore,
  isOpaqueIdentity,
  tandemSessionIdentity,
  type ClaudeLifecycleEvent,
  type ClaudeLifecycleKind,
} from './claude-lifecycle-store.ts'

/**
 * Refuse to even parse anything larger. The documented payload is a few hundred
 * bytes plus one assistant message; a megabyte of it is a malfunction, and
 * parsing it would cost the user's turn boundary real time.
 */
export const MAX_HOOK_INPUT_BYTES = 1024 * 1024

/** The hook event names this hook is registered for. */
const KIND_BY_EVENT: Readonly<Record<string, ClaudeLifecycleKind>> = {
  Stop: 'stop',
  StopFailure: 'stop_failure',
}

/**
 * Why a payload did or did not become a record. Diagnostic only — every value
 * exits 0 — but each is a distinct thing a test (and a future operator running
 * with the debug flag) needs to be able to tell apart.
 */
export type ClaudeHookOutcome =
  | 'recorded'
  /** Well-formed, but this Claude was not started by Tandem: no session id in
   *  the environment. The overwhelmingly common case on a developer's machine,
   *  and not an error. */
  | 'not_tandem'
  /** Not a payload this hook handles: unparseable, not an object, oversized, or
   *  an event name that is not Stop/StopFailure. */
  | 'ignored'
  /** A Stop/StopFailure payload whose required fields are missing or unusable. */
  | 'invalid'
  /** Everything was fine; the store could not be written. */
  | 'unwritable'

export interface ClaudeHookResult {
  /** Always 0. Present so the caller states the guarantee rather than assumes it. */
  exitCode: 0
  /** Always empty. See "silent by design" above. */
  stdout: ''
  outcome: ClaudeHookOutcome
  /** The stored event, on `recorded` only. Never printed; for tests and callers. */
  event?: ClaudeLifecycleEvent
}

function result(outcome: ClaudeHookOutcome, event?: ClaudeLifecycleEvent): ClaudeHookResult {
  return { exitCode: 0, stdout: '', outcome, ...(event ? { event } : {}) }
}

export interface ClaudeHookOptions {
  store?: ClaudeLifecycleStore
  env?: NodeJS.ProcessEnv
  /** Test seam only. */
  now?: Date
}

/**
 * Handle one hook payload. `raw` is the exact bytes Claude wrote to stdin.
 *
 * Total: every path returns a result and none throws.
 */
export function handleClaudeStopHook(raw: string, opts: ClaudeHookOptions = {}): ClaudeHookResult {
  try {
    if (typeof raw !== 'string') return result('ignored')
    if (Buffer.byteLength(raw, 'utf8') > MAX_HOOK_INPUT_BYTES) return result('ignored')
    const text = raw.trim()
    if (text.length === 0) return result('ignored')

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return result('ignored')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result('ignored')
    const payload = parsed as Record<string, unknown>

    const eventName = payload.hook_event_name
    if (typeof eventName !== 'string') return result('ignored')
    const kind = Object.prototype.hasOwnProperty.call(KIND_BY_EVENT, eventName)
      ? KIND_BY_EVENT[eventName]
      : undefined
    // Registered for something else, or a Claude that grew a new event name:
    // not this hook's business, and not an error.
    if (!kind) return result('ignored')

    // From here the payload IS one we handle, so a bad field is `invalid`
    // rather than `ignored` — the distinction is what makes a genuinely
    // malformed Stop visible under the debug flag instead of looking routine.
    const claudeSessionId = payload.session_id
    if (!isOpaqueIdentity(claudeSessionId)) return result('invalid')

    // Identity is supplied by the spawning Tandem, never inferred here. Its
    // absence means a hand-started Claude, which Tandem has no business
    // recording — and no way to attribute if it did.
    const tandemSession = tandemSessionIdentity(opts.env ?? process.env)
    if (!tandemSession) return result('not_tandem')

    // `Stop` carries the last assistant message; `StopFailure` does not, and a
    // failure's text is not something to guess at from another field.
    const rawMessage = kind === 'stop' ? payload.last_assistant_message : undefined
    const message = typeof rawMessage === 'string' && rawMessage.length > 0 ? rawMessage : undefined

    const store = opts.store ?? defaultClaudeLifecycleStore()
    const event = store.record({
      kind,
      tandemSession,
      claudeSessionId,
      ...(message ? { message } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    })
    return event ? result('recorded', event) : result('unwritable')
  } catch {
    // Unreachable by construction; here because "never throws" must hold even
    // if a future edit above stops being total.
    return result('ignored')
  }
}

/** Host opt-in: emit the outcome word (and nothing else) on stderr. */
export function hookDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TANDEM_CLAUDE_HOOK_DEBUG?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}
