/**
 * claude-completion.ts — reading Claude's OWN turn boundary back out of the
 * lifecycle store, and deciding whether it belongs to the turn Tandem is
 * currently waiting on.
 *
 * THE PROBLEM THIS SOLVES. Tandem's completion signal is inferred from the
 * outside: the terminal backend watches a pane and decides a turn probably
 * ended. bridge/turn-ledger.ts makes that inference reportable exactly once,
 * but it cannot make it true, and the expensive failure is the silent one —
 * a backend that reports `working` forever. Live-measured against Herdr: an
 * agent whose settled state never advances leaves `isCurrentlyWorking()`
 * answering true indefinitely, so a foreman polls a finished turn until it
 * gives up. Claude's own `Stop` hook is the signal that ends that: Claude runs
 * it in its own process, at its own turn boundary, and says the turn is over.
 *
 * WHY A BASELINE, AND WHY IT MUST BE DURABLE. The store is append-only and
 * shared by every Tandem-driven Claude on the host. A record in it is only
 * evidence about THIS turn if it was written AFTER this turn started, so
 * send() snapshots the store's cursor (`seq` + `storeEpoch`) before delivering
 * the instruction and parks it alongside the pending turn in the turn ledger.
 * Without that snapshot the previous turn's `Stop` — still retained, sitting
 * right there — would end the new turn the instant it was polled.
 *
 * `storeEpoch` is carried too because a `seq` from a store that has since been
 * replaced is not comparable to one from the store now on disk. The store
 * reports that as `truncated`, and truncated means "cannot order these events"
 * — which here means: claim nothing, and let the terminal backend decide, the
 * way it did before this path existed.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not emit, resolve a session, or clear
 * a turn. It answers one question — "did Claude report a turn boundary for
 * this session after this baseline?" — and router.ts decides what that means.
 * Exactly-once remains the turn ledger's job, not this module's: two polls that
 * both see the same `Stop` both get the same answer here, and only the first
 * one gets a turn out of the ledger to report.
 */
import {
  MAX_RETAINED_EVENTS,
  defaultClaudeLifecycleStore,
  type ClaudeLifecycleKind,
  type ClaudeLifecycleStore,
} from './claude-lifecycle-store.ts'

/**
 * Where the lifecycle store stood when a turn was opened, plus the opaque
 * identity of the worker that turn was sent to. Persisted with the pending turn
 * (see turn-ledger.ts) so a bridge restart and a cold re-adoption still know
 * which records are new.
 */
export interface ClaudeTurnBaseline {
  /** The worker's `TANDEM_SESSION_ID` (see claude-worker-env.ts). */
  session: string
  /** Highest store seq at the moment the turn was opened. */
  seq: number
  /** The store that issued `seq`; a different one makes it meaningless. */
  storeEpoch: string
}

/** A turn boundary Claude itself reported, attributable to the pending turn. */
export interface ClaudeTurnEnd {
  kind: ClaudeLifecycleKind
  /** The store seq of the record, so a caller can say WHICH record ended it. */
  seq: number
  /** Sanitised, clamped final assistant message (`stop` only, when present). */
  message?: string
  /** The message was longer than the store's clamp and was cut. */
  messageTruncated?: boolean
}

/** A baseline is only usable if every field survived the round trip to disk. */
export function isClaudeTurnBaseline(value: unknown): value is ClaudeTurnBaseline {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    typeof c.session === 'string' &&
    c.session.length > 0 &&
    typeof c.seq === 'number' &&
    Number.isSafeInteger(c.seq) &&
    c.seq >= 0 &&
    typeof c.storeEpoch === 'string' &&
    c.storeEpoch.length > 0
  )
}

/**
 * The FIRST turn boundary this worker reported after `baseline`, or undefined.
 *
 * Oldest-first, deliberately: the first record after the baseline is the
 * boundary of the turn that baseline opened. A later one belongs to whatever
 * came next and is not this turn's to consume.
 *
 * Never throws. Every way of not knowing — no baseline, an unreadable store, a
 * reset store, a record from a different worker — returns undefined, which
 * leaves the caller exactly where it was before this path existed.
 */
export function claudeTurnEndAfter(
  baseline: ClaudeTurnBaseline | undefined,
  store: ClaudeLifecycleStore = defaultClaudeLifecycleStore(),
): ClaudeTurnEnd | undefined {
  if (!baseline) return undefined
  try {
    // Scan the whole retained window: the store is shared by every Tandem
    // Claude on the host, so this worker's record can sit behind any number of
    // other workers' records, and a short page would simply miss it.
    const page = store.readAfter(baseline.seq, { limit: MAX_RETAINED_EVENTS, storeEpoch: baseline.storeEpoch })
    // Retention dropped past the baseline, or the store was replaced: the seqs
    // are not comparable, so nothing here is evidence about this turn.
    if (page.truncated) return undefined
    const event = page.events.find((e) => e.seq > baseline.seq && e.tandemSession === baseline.session)
    if (!event) return undefined
    return {
      kind: event.kind,
      seq: event.seq,
      ...(event.message ? { message: event.message } : {}),
      ...(event.messageTruncated ? { messageTruncated: true } : {}),
    }
  } catch {
    // A store that cannot answer must never break the poll it was consulted on.
    return undefined
  }
}
