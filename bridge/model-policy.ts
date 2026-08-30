/**
 * model-policy.ts — Claude model ROUTING policy, enforced at the API layer.
 *
 * Two rules live here, and only here, so the router, the fleet op table, the
 * MCP tool descriptions, and `get_orchestration_policy` can never drift apart:
 *
 *   1. DEFAULT MODEL. A new Claude session opened without an explicit model
 *      gets the `opus` alias (Opus 5 — the strongest general model), rather
 *      than inheriting whatever the host's `claude` CLI happens to default to.
 *      Orchestrated workers do real engineering work; the default must be the
 *      capable model, not the cheap one. Narrower helpers (read-only lookups,
 *      mechanical edits) are opted DOWN to `sonnet` explicitly by the caller,
 *      and `haiku` stays exceptional. This function only supplies the default —
 *      an explicit alias always wins.
 *
 *   2. FABLE IS EXPLICIT-USER-ONLY. `fable` / `claude-fable-*` is never
 *      selected by an orchestrating model on its own initiative. Requesting it
 *      requires the caller to pass `user_requested_fable: true`, which it may
 *      only do when the user's CURRENT instruction explicitly asks for Fable.
 *      Without that flag the call is REJECTED (a clean 400) — never silently
 *      downgraded to another model, because silently substituting a model the
 *      caller did not ask for is its own failure mode.
 *
 * Both checks run BEFORE any spawn, tmux/Herdr lookup, or network side effect
 * (same ordering rule as engine resolution — see engine-registry.ts), so a
 * rejected Fable request costs nothing and leaves no session behind.
 */
import { validateModel } from './terminal-session.ts'

/** Alias applied to a new Claude session when the caller names no model. */
export const DEFAULT_CLAUDE_MODEL = 'opus'

/** The gated alias. */
export const FABLE_ALIAS = 'fable'

/** The gated full model id (accepted in addition to the alias). */
export const FABLE_FULL_MODEL_ID = 'claude-fable-5'

/** The request field a caller must set to `true` to be allowed a Fable model. */
export const FABLE_CONSENT_FIELD = 'user_requested_fable'

/** Raised when a Fable model was requested without explicit user consent. */
export class FableConsentRequiredError extends Error {}

/** Raised when the consent field is present but is not a boolean. */
export class FableConsentMalformedError extends Error {}

/**
 * True for the `fable` alias and for any full `claude-fable-*` id (e.g.
 * `claude-fable-5`, `claude-fable-5[1m]`), case-insensitively. The negative
 * lookahead keeps a hypothetical unrelated `claude-fablesomething` model from
 * being swept into the gate by prefix alone.
 */
export function isFableModel(model: string): boolean {
  const m = model.trim().toLowerCase()
  if (m === FABLE_ALIAS) return true
  return /^claude-fable(?![a-z0-9])/.test(m)
}

/**
 * Reads the consent flag out of a raw request body. Absent → false. Present
 * but not a boolean → a typed error, so a caller that sends the string
 * `"true"` (or a truthy number) is told plainly rather than being quietly
 * granted, or quietly denied, a gated model.
 */
export function readFableConsent(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  if (typeof raw !== 'boolean') {
    throw new FableConsentMalformedError(
      `${FABLE_CONSENT_FIELD} must be a boolean (true only when the user's current instruction explicitly asked for Fable).`,
    )
  }
  return raw
}

/** Throws unless a Fable model carries explicit user consent. */
function assertFableConsent(model: string, userRequestedFable: boolean): void {
  if (!isFableModel(model) || userRequestedFable) return
  throw new FableConsentRequiredError(
    `model "${model}" is Fable, which is explicit-user-only. Set ${FABLE_CONSENT_FIELD}: true, ` +
      "and only when the user's current instruction explicitly requested Fable — never infer it, " +
      'and never select Fable on your own initiative.',
  )
}

/**
 * Session-open model resolution: validate, enforce the Fable gate, and supply
 * the Opus default when the caller named no model. Always returns a model —
 * a new Claude session is never opened without one.
 */
export function resolveOpenModel(raw: string | undefined, userRequestedFable: boolean): string {
  if (raw === undefined) return DEFAULT_CLAUDE_MODEL
  const model = validateModel(raw)
  assertFableConsent(model, userRequestedFable)
  return model
}

/**
 * Per-turn override resolution: validate and enforce the same Fable gate, but
 * supply NO default — an omitted per-turn model means "keep the session's own
 * model", not "switch this turn to Opus".
 */
export function resolveTurnModel(raw: string | undefined, userRequestedFable: boolean): string | undefined {
  if (raw === undefined) return undefined
  const model = validateModel(raw)
  assertFableConsent(model, userRequestedFable)
  return model
}
