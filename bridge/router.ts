/**
 * router.ts — local RPC router (the TRUST BOUNDARY).
 *
 * Network transport stays outside this module. Tandem's MCP servers call
 * `route()` directly in-process, keeping the route table, handlers, name
 * validation, relay-owned isolation, cwd admission, and audit policy inside
 * one explicit trust boundary.
 *
 * ENGINE-AWARE (Phase 2): a drivable "session" is either a REAL interactive
 * Claude/Codex TUI managed by the selected native terminal backend (tmux or
 * Herdr), a tmux shell, or an attached Hermes writable-agent id. We
 * NEVER run `claude -p` / headless and NEVER set ANTHROPIC_API_KEY, so Claude
 * usage stays on the user's interactive subscription. The autonomous capability
 * is the zero-API two-session relay, which stays Claude-only and unaffected by
 * engine selection.
 *
 * ENGINE RESOLUTION ORDER (binding — Phase 2 correction E): every open_session
 * call resolves and validates the engine (unknown id → 400, disabled → 403,
 * enabled-but-unavailable executable → 503) via engine-registry.ts BEFORE any
 * cwd resolution, tmux lookup, spawn, or network side effect. An engine
 * mismatch on session-NAME reuse (a name already open under a different
 * engine) is rejected with 409 before any further work too.
 *
 * SECURITY RAILS:
 *   - cwd ALLOWLIST (buildAllowlist / isCwdAllowed / safeResolve from
 *     sessions.ts). Any cwd outside the allowlist is rejected with a clean 403.
 *     Paths are realpath-canonicalized before the check so `..` / symlink escapes
 *     can't slip through, and the prefix comparison uses a trailing separator so
 *     "/srv/code" does NOT match "/srv/code-evil".
 *   - Only ccm-* tmux sessions (claude/codex/shell) or an allowlisted Hermes
 *     agent id are drivable.
 *   - tmux send-keys is injection-safe (-l literal + -- end-of-options).
 *   - Audit log: every spawn / send / interrupt / close / relay control appends
 *     metadata only to a private ~/.tandem/bridge.log. Prompt, command, task,
 *     goal, context, report, output, and request-body values are replaced with
 *     byte counts. A failed audit write surfaces to stderr.
 *
 * Config (env): TANDEM_CWD_ALLOWLIST / TANDEM_DEFAULT_CWD are mapped to the
 * engine's CCM_* names by the entrypoint before this module loads.
 * TANDEM_ENABLED_ENGINES opts non-default engines in (see engine-registry.ts).
 */

import { homedir } from 'node:os'
import { validateEffort } from './terminal-session.ts'
import { FABLE_CONSENT_FIELD, readFableConsent, resolveOpenModel, resolveTurnModel } from './model-policy.ts'
import type { DrivableSession, EngineId } from './drivable.ts'
import type { TerminalSessionLike } from './engines/terminal-adapter.ts'
import {
  resolveEngine,
  UnknownEngineError,
  EngineDisabledError,
  EngineUnavailableError,
} from './engine-registry.ts'
import { ClaudeSession } from './engines/claude.ts'
import { CodexSession } from './engines/codex.ts'
import { ShellSession } from './engines/shell.ts'
import { HermesSession, loadHermesConfig } from './engines/hermes.ts'
import {
  buildAllowlist,
  isCwdAllowed,
  safeResolve,
  getLive,
  registerLive,
  unregisterLive,
  listSessions,
} from './sessions.ts'
import * as relay from './relay.ts'
import { emitCompletion, emitLifecycle, summarize, type EmitTurn } from './events.ts'
import { claudeTurnEndAfter, type ClaudeTurnBaseline, type ClaudeTurnEnd } from './claude-completion.ts'
import { defaultClaudeLifecycleStore } from './claude-lifecycle-store.ts'
import { tandemSessionIdFor } from './claude-worker-env.ts'
import { defaultTurnLedger } from './turn-ledger.ts'
import {
  currentDeviceId,
  defaultForemanInbox,
  InvalidCheckpointError,
  type ForemanEventPreview,
} from './foreman-inbox.ts'
import { audit } from './audit.ts'
import { terminalBackend, type TerminalEngineId } from './terminal-backend.ts'

// ---- config ---------------------------------------------------------------

const HOME = homedir()
/** The explicit allowlist is built once from env at startup. */
const ALLOWLIST = buildAllowlist()
/** If no default is configured, use the first explicitly allowlisted root. */
const DEFAULT_CWD = process.env.CCM_DEFAULT_CWD ?? ALLOWLIST[0] ?? HOME

export function getAllowlist(): string[] {
  return ALLOWLIST
}

/** A bridge-generated session name when the client doesn't supply one. */
function generateName(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

/** Session names must be tmux/file safe (mirrors TerminalSession.spawn's guard). */
const NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * Relay-owned session names (relay.ts names its internal lead/worker sessions
 * `relay-<loopId>-lead` / `relay-<loopId>-worker`). They satisfy NAME_RE, so the
 * generic session-control routes would otherwise let a remote caller reach INTO
 * the relay's two TUIs out-of-band of the relay protocol. The relay is a separate
 * capability surface; its sessions are drivable ONLY through the /relay/* routes.
 */
const RELAY_NAME_RE = /^relay-/

export function isRelayOwned(name: string): boolean {
  return RELAY_NAME_RE.test(name)
}

// ---- RPC routing ----------------------------------------------------------

export interface RpcRequest {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown>
}

export interface RpcResult {
  status: number
  body: unknown
}

function ok(body: unknown): RpcResult {
  return { status: 200, body }
}
function err(status: number, message: string): RpcResult {
  return { status, body: { error: message } }
}

function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/**
 * Test/entry seam: run the router with a minimal request shape. The MCP server
 * calls this for every tool invocation.
 */
export async function routeForTest(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  rawQuery = '',
): Promise<RpcResult> {
  return route({ method, path, query: new URLSearchParams(rawQuery), body })
}

export async function route(req: RpcRequest): Promise<RpcResult> {
  const parts = pathParts(req.path)
  const m = req.method.toUpperCase()

  // GET /sessions
  if (m === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
    const limit = req.query.get('limit') ? Number(req.query.get('limit')) : undefined
    const project = req.query.get('project') ?? undefined
    // `sessions` is exactly what it has always been. `recent_events` is
    // ADDITIVE and bounded — see recentEventsPreview below.
    return ok({ ...(await listSessions({ limit, project })), recent_events: recentEventsPreview() })
  }

  // POST /sessions/open
  if (m === 'POST' && parts.length === 2 && parts[0] === 'sessions' && parts[1] === 'open') {
    return handleOpen(req)
  }

  // GET /foreman/events — read-only reconciliation feed (see foreman-inbox.ts).
  if (m === 'GET' && parts.length === 2 && parts[0] === 'foreman' && parts[1] === 'events') {
    return handleForemanEvents(req)
  }

  // .../sessions/:name/<action>
  if (parts.length === 3 && parts[0] === 'sessions') {
    const name = decodeURIComponent(parts[1])
    const action = parts[2]
    // Relay-owned sessions are isolated from the generic session routes.
    if (isRelayOwned(name)) {
      audit({ route: `${m} /sessions/:name/${action}`, name, denied: 'relay-owned' })
      return err(409, `session "${name}" is relay-owned; use the relay routes`)
    }
    if (m === 'POST' && action === 'send') return handleSend(name, req)
    if (m === 'GET' && action === 'read') return handleRead(name, req)
    if (m === 'POST' && action === 'interrupt') return handleInterrupt(name)
    if (m === 'POST' && action === 'close') return handleClose(name)
  }

  // POST /relay/start
  if (m === 'POST' && parts.length === 2 && parts[0] === 'relay' && parts[1] === 'start') {
    if (terminalBackend.kind === 'herdr') {
      return err(409, 'the Claude-only relay is unavailable with the Herdr terminal backend')
    }
    return handleRelayStart(req)
  }

  // .../relay/:loopId/<action>
  if (parts.length === 3 && parts[0] === 'relay') {
    const loopId = decodeURIComponent(parts[1])
    const action = parts[2]
    if (m === 'GET' && action === 'read') return handleRelayRead(loopId, req)
    if (m === 'POST' && action === 'stop') {
      audit({ route: 'POST /relay/:loopId/stop', loopId })
      return ok(relay.stop(loopId))
    }
    if (m === 'POST' && action === 'inject') {
      const message = String(req.body['message'] ?? '')
      if (!message) return err(400, 'message is required')
      audit({ route: 'POST /relay/:loopId/inject', loopId, text: message })
      return ok(relay.inject(loopId, message))
    }
    if (m === 'POST' && action === 'enqueue') {
      const task = String(req.body['task'] ?? req.body['message'] ?? '')
      if (!task.trim()) return err(400, 'task is required')
      audit({ route: 'POST /relay/:loopId/enqueue', loopId, task })
      return ok(relay.enqueue(loopId, task))
    }
  }

  return err(404, `no route for ${m} ${req.path}`)
}

// ---- session listing -------------------------------------------------------

/**
 * The bounded recent-transition preview carried alongside `sessions`.
 *
 * WHY IT HANGS OFF list_sessions. An MCP client caches a server's tool list for
 * the life of a conversation; nothing in the protocol re-reads the schema, and
 * no server can wake a client to make it. A chat that was open before this
 * server gained `get_foreman_events` therefore cannot call it, however
 * correctly the policy tells it to — but it still calls `list_sessions`, which
 * was in the schema it cached. This field is the only route a completion has
 * back to that conversation.
 *
 * ADDITIVE AND FAIL-SOFT, IN THAT ORDER. `sessions` is byte-identical to what
 * it was; a client that ignores unknown fields sees no change at all. And a
 * preview that cannot be produced is omitted rather than raised: listing live
 * sessions is the load-bearing half of this route and must not start failing
 * because a summary could not be read.
 *
 * It is NOT the history surface. It carries no caller checkpoint and cannot be
 * paged, so `get_foreman_events` remains preferred for anything that must be
 * seen exactly once. See bridge/foreman-inbox.ts's ForemanEventPreview.
 */
function recentEventsPreview(): ForemanEventPreview | undefined {
  try {
    return defaultForemanInbox().preview()
  } catch {
    return undefined
  }
}

// ---- foreman reconciliation ----------------------------------------------

/**
 * Read the durable foreman event feed. STRICTLY READ-ONLY: it opens nothing,
 * touches no session, and — unlike a server-side acknowledgement — writes
 * nothing at all. The caller carries its own opaque checkpoint, which is the
 * only design that can be per-client on a stateless transport with no client
 * identity (see bridge/foreman-inbox.ts and docs/foreman-events.md).
 *
 * The audit line records that a read happened and how much it returned; the
 * checkpoint is not logged, since it is the caller's cursor, not ours.
 */
function handleForemanEvents(req: RpcRequest): RpcResult {
  const since = req.query.get('since') ?? undefined
  const rawLimit = req.query.get('limit')
  const limit = rawLimit !== null && rawLimit !== '' ? Number(rawLimit) : undefined
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    return err(400, 'limit must be a positive integer')
  }
  try {
    const page = defaultForemanInbox().read({ since, limit })
    audit({
      route: 'GET /foreman/events',
      returned: page.counts.returned,
      retained: page.counts.retained,
      truncated: page.truncated,
      more: page.more,
    })
    return ok(page)
  } catch (e) {
    if (e instanceof InvalidCheckpointError) {
      // Explicit, not silent: a checkpoint we cannot read must not be treated
      // as "start from the beginning" or "start from now" behind the caller's
      // back — either would misreport what it has already seen.
      return err(400, `${e.message}; omit "since" to start a fresh checkpoint`)
    }
    return err(500, 'failed to read the foreman event feed')
  }
}

// ---- turn boundaries ------------------------------------------------------

/**
 * The identity of the agent currently answering to `name`. A backend that can
 * report a per-incarnation identity (tmux session id + creation time, Herdr
 * workspace + terminal id) makes a reopened name distinguishable from the one
 * it replaced; one that cannot falls back to a name-derived identity, which
 * still de-duplicates repeated polls and still survives a restart.
 */
async function agentIdentityOf(session: DrivableSession): Promise<string> {
  try {
    const identity = await session.agentIdentity?.()
    if (identity) return identity
  } catch {
    // A backend that cannot answer must not break the turn it is reporting on.
  }
  return `${session.engine}:${session.id}`
}

/** The EmitTurn carried into events.ts for a session-sourced event. */
function turnOf(session: DrivableSession, ref: { epoch: number; turnSeq: number }): EmitTurn {
  return { epoch: ref.epoch, turn: ref.turnSeq, engine: session.engine, device: currentDeviceId() }
}

/**
 * Where the Claude lifecycle store stands right now, taken BEFORE a turn is
 * delivered so a boundary Claude reports afterwards is attributable to it.
 *
 * Claude only: no other engine has a hook that writes into that store. Never
 * throws — a baseline that cannot be taken simply means this turn will be
 * decided the way every turn was before this path existed, by the backend.
 */
function claudeBaselineFor(session: DrivableSession, name: string): ClaudeTurnBaseline | undefined {
  if (session.engine !== 'claude') return undefined
  try {
    const cursor = defaultClaudeLifecycleStore().snapshot()
    return { session: tandemSessionIdFor(name), seq: cursor.seq, storeEpoch: cursor.storeEpoch }
  } catch {
    return undefined
  }
}

// ---- session handlers -----------------------------------------------------

async function handleOpen(req: RpcRequest): Promise<RpcResult> {
  const rawName = req.body['name'] !== undefined ? String(req.body['name']) : generateName()
  const name = rawName.trim()
  if (!NAME_RE.test(name)) {
    return err(400, `invalid session name (allowed: A-Z a-z 0-9 . _ -): ${name}`)
  }
  // The relay- namespace is reserved for relay.ts's internal sessions.
  if (isRelayOwned(name)) {
    audit({ route: 'POST /sessions/open', name, denied: 'relay-owned' })
    return err(409, `session name "${name}" is reserved for the relay; use the relay routes`)
  }

  // Resolve + validate the engine FIRST — before any cwd/tmux/network side
  // effect (binding — Phase 2 correction E). Defaults to "claude" (the only
  // engine enabled by default); codex/shell/hermes require explicit opt-in via
  // TANDEM_ENABLED_ENGINES.
  const rawEngine = req.body['engine'] !== undefined ? String(req.body['engine']) : undefined
  let engine: EngineId
  try {
    ;({ id: engine } = await resolveEngine(rawEngine))
  } catch (e) {
    if (e instanceof UnknownEngineError) return err(400, e.message)
    if (e instanceof EngineDisabledError) return err(403, e.message)
    if (e instanceof EngineUnavailableError) return err(503, e.message)
    return err(500, e instanceof Error ? e.message : String(e))
  }

  // An engine mismatch on name reuse is rejected before any further work,
  // regardless of which engine's open path would otherwise run.
  const liveExisting = getLive(name)
  if (liveExisting && liveExisting.engine !== engine) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'engine-mismatch', existingEngine: liveExisting.engine })
    return err(409, `session "${name}" already exists with engine "${liveExisting.engine}"`)
  }

  if (engine === 'hermes') {
    return handleOpenHermes(name, req)
  }
  return handleOpenTerminalBackend(engine, name, req)
}

/** open_session for the `hermes` engine: attach to an existing, explicitly
 *  allowlisted writable agent id. No spawn, no cwd, no model/effort — Hermes
 *  rejects all three (binding — Phase 2 correction E). */
async function handleOpenHermes(name: string, req: RpcRequest): Promise<RpcResult> {
  if (req.body['cwd'] !== undefined) return err(400, 'cwd is not supported for engine "hermes"')
  if (req.body['model'] !== undefined) return err(400, 'model is not supported for engine "hermes"')
  if (req.body['effort'] !== undefined) return err(400, 'effort is not supported for engine "hermes"')
  if (req.body[FABLE_CONSENT_FIELD] !== undefined) {
    return err(400, `${FABLE_CONSENT_FIELD} is not supported for engine "hermes"`)
  }

  const existing = getLive(name)
  if (existing) {
    audit({ route: 'POST /sessions/open', name, engine: 'hermes', reused: true })
    return ok({ name: existing.id, engine: 'hermes', attachHint: existing.attachHint(), reused: true })
  }

  // A tmux-hosted session may have survived a bridge restart without yet being
  // re-adopted into the in-memory registry. Never let a Hermes attachment claim
  // that live session's name and hide/misroute it. Any ccm-<name> collision is a
  // conflict, including an untagged one.
  if (await terminalBackend.exists(name)) {
    const existingEngine = await terminalBackend.engineTagOf(name)
    audit({
      route: 'POST /sessions/open',
      name,
      engine: 'hermes',
      denied: 'tmux-name-conflict',
      ...(existingEngine ? { existingEngine } : {}),
    })
    return err(
      409,
      existingEngine
        ? `session "${name}" already exists with engine "${existingEngine}"`
        : `session "${name}" already exists as a tmux session`,
    )
  }

  const config = loadHermesConfig()
  if (!config) {
    audit({ route: 'POST /sessions/open', name, engine: 'hermes', denied: 'not-configured' })
    return err(503, 'Hermes is not configured (set TANDEM_HERMES_BASE_URL)')
  }
  // Allowlist enforced HERE (registry/router) AND again inside HermesSession.attach
  // (binding — Phase 2 correction D: "enforce the writable-agent id allowlist in
  // both the registry/router and the Hermes adapter").
  if (!config.writableAgents.has(name)) {
    audit({ route: 'POST /sessions/open', name, engine: 'hermes', denied: 'not-writable-allowlisted' })
    return err(403, `Hermes agent "${name}" is not on the writable-agent allowlist`)
  }
  try {
    const session = HermesSession.attach({ agentId: name, config })
    registerLive(session)
    audit({ route: 'POST /sessions/open', name: session.id, engine: 'hermes' })
    return ok({ name: session.id, engine: 'hermes', attachHint: session.attachHint() })
  } catch (e) {
    return err(500, `failed to attach Hermes agent: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function wrapTerminal(engine: TerminalEngineId, terminal: TerminalSessionLike) {
  return engine === 'claude'
    ? new ClaudeSession(terminal)
    : engine === 'codex'
      ? new CodexSession(terminal)
      : new ShellSession(terminal)
}

/**
 * Re-adopt a terminal-backend session that survived a bridge restart without
 * yet being re-registered in-memory (re-validates ownership tags + cwd
 * allowlist, same as handleOpenTerminalBackend's adoption path). Registers
 * the adopted session so subsequent calls hit the fast already-live path.
 * Returns undefined when nothing this installation owns answers to that
 * name, or its cwd is no longer admissible — never for a Hermes session,
 * which has no tmux/Herdr-backend inventory to re-adopt from.
 */
async function adoptLiveTerminalSession(name: string): Promise<DrivableSession | undefined> {
  const engine = await terminalBackend.engineTagOf(name)
  if (!engine) return undefined
  const adoptedTerminal = await terminalBackend.attachExisting(name, engine, ALLOWLIST)
  if (!adoptedTerminal) return undefined
  const session = wrapTerminal(engine, adoptedTerminal)
  registerLive(session)
  return session
}

/**
 * In-flight re-adoptions, keyed by session name. Two concurrent callers for
 * the same not-yet-registered name (e.g. a racing send + read right after a
 * bridge restart) must converge on the SAME adopted DrivableSession, not each
 * build their own TerminalSessionLike wrapper around independently-called
 * `attachExisting` results — two wrappers around the same underlying Herdr
 * agent would track cursor/read state independently (see
 * HerdrTerminalSession's emitted-output cursor), and whichever `registerLive`
 * call landed last would silently orphan the other caller's wrapper, which
 * then keeps driving the session through state the registry no longer
 * references.
 */
const inFlightAdoptions = new Map<string, Promise<DrivableSession | undefined>>()

/**
 * getLive(), falling back to re-adoption. This is what makes a session
 * `list_sessions` advertises as live after a bridge restart transparently
 * drivable by send/read/interrupt too, not just open_session/close — the
 * bridge's in-memory registry losing a session across a restart must never
 * be visible to a caller that only ever saw it as live.
 */
async function getLiveOrAdopt(name: string): Promise<DrivableSession | undefined> {
  const existing = getLive(name)
  if (existing) return existing
  const inFlight = inFlightAdoptions.get(name)
  if (inFlight) return inFlight
  const adoption = adoptLiveTerminalSession(name).finally(() => {
    // Only clear this name's own in-flight entry — a later call may have
    // already started a fresh adoption attempt under the same key (e.g. this
    // one failed and a subsequent open_session re-admitted the cwd).
    if (inFlightAdoptions.get(name) === adoption) inFlightAdoptions.delete(name)
  })
  inFlightAdoptions.set(name, adoption)
  return adoption
}

/** open_session for claude/codex/shell through the selected terminal backend. */
async function handleOpenTerminalBackend(engine: TerminalEngineId, name: string, req: RpcRequest): Promise<RpcResult> {
  // Per-session model/effort (optional, Claude only — binding Phase 2 correction
  // C: no silent option loss for codex/shell). Validated up front so a bad value
  // fails as a clean 400 rather than a generic 500 from spawn.
  let model: string | undefined
  let effort: string | undefined
  if (engine === 'claude') {
    try {
      // resolveOpenModel also supplies the Opus default for an omitted model
      // and enforces the explicit-user-only Fable gate — both BEFORE any cwd
      // resolution, backend lookup, or spawn (see bridge/model-policy.ts).
      const rawModel = req.body['model'] !== undefined ? String(req.body['model']) : undefined
      model = resolveOpenModel(rawModel, readFableConsent(req.body[FABLE_CONSENT_FIELD]))
      if (req.body['effort'] !== undefined) effort = validateEffort(String(req.body['effort']))
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e))
    }
  } else {
    if (req.body['model'] !== undefined) return err(400, `model is not supported for engine "${engine}"`)
    if (req.body['effort'] !== undefined) return err(400, `effort is not supported for engine "${engine}"`)
    // The consent field only ever qualifies a Claude model. Accepting it
    // silently for an engine that has no model would be exactly the silent
    // option loss the rest of this handler refuses (Phase 2 correction C).
    if (req.body[FABLE_CONSENT_FIELD] !== undefined) {
      return err(400, `${FABLE_CONSENT_FIELD} is not supported for engine "${engine}"`)
    }
  }

  // Idempotent: reuse a session already live under this name (engine already
  // confirmed to match by the caller, handleOpen).
  const existing = getLive(name)
  if (existing) {
    audit({ route: 'POST /sessions/open', name, engine, cwd: existing.cwd, reused: true })
    return ok({ name: existing.id, engine, cwd: existing.cwd, attachHint: existing.attachHint(), reused: true })
  }

  // A live, already-admitted session can be reused without re-applying a cwd
  // admission check. Fresh spawn and restart adoption still require the
  // explicit allowlist below. Keeping this after option validation also means
  // unsupported controls never become silent no-ops on reuse.
  const cwdInput = req.body['cwd'] !== undefined ? String(req.body['cwd']) : DEFAULT_CWD
  if (!isCwdAllowed(cwdInput, ALLOWLIST)) {
    return err(403, `cwd not allowed: ${cwdInput}`)
  }
  const cwd = safeResolve(cwdInput)

  // A same-named ccm-* tmux session tagged with a DIFFERENT engine is a 409
  // conflict, distinct from a provenance/cwd adoption failure (403) — checked
  // before attempting adoption so the caller gets the precise reason.
  const existingTag = await terminalBackend.engineTagOf(name)
  if (existingTag !== undefined && existingTag !== engine) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'engine-mismatch', existingEngine: existingTag })
    return err(409, `session "${name}" already exists with engine "${existingTag}"`)
  }

  // Re-adopt a ccm-* session that survived a bridge restart (re-validates
  // provenance tags + cwd).
  const adoptedTerminal = await terminalBackend.attachExisting(name, engine, ALLOWLIST)
  const adopted = adoptedTerminal ? wrapTerminal(engine, adoptedTerminal) : undefined
  if (adopted) {
    registerLive(adopted)
    audit({ route: 'POST /sessions/open', name, engine, cwd: adopted.cwd, adopted: true })
    return ok({ name: adopted.id, engine, cwd: adopted.cwd, attachHint: adopted.attachHint(), reused: true })
  }
  const stillExists = await terminalBackend.exists(name)
  if (stillExists) {
    audit({ route: 'POST /sessions/open', name, engine, denied: 'adopt-provenance-or-cwd' })
    return err(
      403,
      `existing session "${name}" has a cwd outside the allowlist or unrecognized provenance; refusing to adopt`,
    )
  }

  try {
    const terminal = await terminalBackend.spawn({ name, engine, cwd, allowlist: ALLOWLIST, model, effort })
    const session = wrapTerminal(engine, terminal)
    registerLive(session)
    audit({ route: 'POST /sessions/open', name: session.id, engine, cwd, model, effort, ready: session.ready })
    // Surface readiness: when the TUI did NOT reach its prompt (the classic
    // CPU-starved / blank-pane boot failure), include an actionable warning so the
    // caller doesn't silently drive a dead session believing it opened cleanly.
    return ok({
      name: session.id,
      engine,
      cwd: session.cwd,
      attachHint: session.attachHint(),
      ready: session.ready,
      ...(session.readinessWarning ? { warning: session.readinessWarning } : {}),
    })
  } catch (e) {
    return err(500, `failed to open session: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleSend(name: string, req: RpcRequest): Promise<RpcResult> {
  const session = await getLiveOrAdopt(name)
  if (!session) return err(409, `session "${name}" is not live; call open_session first`)

  // The consent field is validated HERE — before poll mode, and independently
  // of whether model/effort were supplied — so its contract does not depend on
  // which other fields happen to be present. A caller that sends the STRING
  // "true" is told plainly rather than having a malformed consent claim quietly
  // ignored on one shape of call and rejected on another. Like model/effort, it
  // is Claude-only: it qualifies a Claude model, so an engine that has no model
  // rejects it instead of silently accepting it.
  if (req.body[FABLE_CONSENT_FIELD] !== undefined) {
    if (session.engine !== 'claude') {
      return err(400, `${FABLE_CONSENT_FIELD} is a Claude-only option; not supported for engine "${session.engine}"`)
    }
    try {
      readFableConsent(req.body[FABLE_CONSENT_FIELD])
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e))
    }
  }

  const text = String(req.body['text'] ?? '')

  // POLL MODE: empty text means "don't send a new instruction, just fetch new
  // output since the cursor". This folds the former read_session into this one
  // tool so the normal path never needs a separate poll tool. (Per-send
  // model/effort overrides are ignored here — there is no turn to apply them to,
  // and a well-formed consent flag is likewise inert: no model is selected on a
  // poll, so there is nothing for it to gate. Its FORM was already checked
  // above, so a malformed claim never passes silently on this path either.)
  if (!text) {
    const cursor = req.body['cursor'] !== undefined ? Number(req.body['cursor']) : 0
    return readSession(name, cursor)
  }

  // Optional per-send model/effort override — Claude-only (binding — Phase 2
  // correction C: no silent option loss for codex/shell/hermes). Validate up
  // front → clean 400, never a generic error from deep inside the adapter.
  let model: string | undefined
  let effort: string | undefined
  if (req.body['model'] !== undefined || req.body['effort'] !== undefined) {
    if (session.engine !== 'claude') {
      return err(400, `model/effort are Claude-only options; not supported for engine "${session.engine}"`)
    }
    try {
      // A per-turn override carries NO Opus default (an omitted model keeps the
      // session's own), but the Fable gate applies identically here — otherwise
      // the guard on open_session could simply be stepped around one turn later.
      const rawModel = req.body['model'] !== undefined ? String(req.body['model']) : undefined
      model = resolveTurnModel(rawModel, readFableConsent(req.body[FABLE_CONSENT_FIELD]))
      if (req.body['effort'] !== undefined) effort = validateEffort(String(req.body['effort']))
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e))
    }
  }

  audit({ route: 'POST /sessions/:name/send', name, engine: session.engine, cwd: session.cwd, text, model, effort })

  // Open the turn BEFORE sending. From here on exactly one completion can be
  // emitted for it — whether it is observed on this call or on a later poll —
  // because the ledger claims it once and the claim is durable.
  const identity = await agentIdentityOf(session)
  const ledger = defaultTurnLedger()
  // Snapshot the lifecycle store BEFORE the instruction goes out, and park it
  // with the pending turn. It is what stops the PREVIOUS turn's `Stop` — still
  // retained in the store — from ending this one the moment it is polled, and
  // it is durable, so a bridge restart and a cold re-adoption keep the
  // distinction instead of losing it (see claude-completion.ts).
  const { superseded } = ledger.beginTurn(name, identity, claudeBaselineFor(session, name))
  if (superseded) {
    // A second instruction arrived while the previous turn was still running.
    // That turn can never report its own completion now, so record that it was
    // cut short rather than letting it disappear from the feed. Reported as
    // `interrupted` because that is what happened to it — the reason
    // distinguishes a caller's interrupt_session from this.
    emitLifecycle({
      type: 'session',
      id: name,
      kind: 'interrupted',
      reason: 'superseded by a later instruction to the same session',
      turn: turnOf(session, superseded),
    })
  }

  try {
    // session.send() is already BOUNDED by the engine's soft cap (TANDEM_WAIT_MS):
    // it returns status:'done' with the report once idle, or status:'running' at
    // the cap so the caller can poll/read again without resending the prompt.
    // Never an infinite internal loop.
    // Per-turn model/effort overrides (if any) are applied by the adapter itself.
    const result = await session.send(text, { model, effort })
    if (result.status === 'done') {
      // Turn finished — EMIT a completion event (push), not just return it.
      const ref = ledger.completeTurn(name, identity)
      if (ref) {
        emitCompletion({
          type: 'session',
          id: name,
          cursor: result.cursor,
          summary: summarize(result.report),
          cwd: session.cwd,
          turn: turnOf(session, ref),
        })
      }
    }
    return ok({
      status: result.status,
      name,
      engine: session.engine,
      report: result.report,
      cursor: result.cursor,
      attachHint: session.attachHint(),
    })
  } catch (e) {
    // The turn is over and produced nothing: close it out so a later poll does
    // not report a completion for work that never finished, and tell the
    // foreman why the session went quiet.
    const ref = ledger.abortTurn(name, identity)
    const reason = e instanceof Error ? e.message : String(e)
    if (ref) emitLifecycle({ type: 'session', id: name, kind: 'error', reason, turn: turnOf(session, ref) })
    return err(500, `send failed: ${reason}`)
  }
}

/**
 * Shared read used by GET /sessions/:name/read AND send poll-mode. Emits the
 * completion of a turn Tandem opened, the first time that turn is observed to
 * have finished.
 *
 * WHY NOT THE OBVIOUS CONTENT TEST. This used to read
 * `if (page.idle && page.text.trim().length > 0)`, which is an observation, not
 * a boundary. read({cursor}) returns everything newer than `cursor`, so polling
 * twice with the SAME cursor — the documented recovery move after an
 * interruption, and what send()-returns-done followed by one confirming poll
 * amounts to — returned the same text twice and manufactured two completion
 * events for one turn. Nor did any of it survive a restart.
 *
 * The ledger answers the real question instead: is there a turn Tandem opened
 * and has not yet reported? It says yes exactly once, durably. A session that
 * is merely idle because a human typed into the TUI is not a turn Tandem drove
 * and is deliberately not reported as one.
 *
 * TWO SIGNALS NOW, IN A FIXED ORDER. `page.idle` is still an INFERENCE about a
 * terminal, and its expensive failure is the silent one: a backend that reports
 * `working` forever leaves a finished turn unreported until the foreman gives
 * up. When Claude ran Tandem's lifecycle hook it left a statement about its own
 * turn boundary in the private store, and that statement is consulted FIRST —
 * it is not a guess about a pane, and when it carries the final assistant
 * message that message is better than a summary of scraped screen text.
 *
 * Everything that ENDS a turn some other way — interrupt_session, close, a
 * superseding send — clears the pending turn AND its baseline before this can
 * run, so none of them can be re-read as a `Stop`. And with no lifecycle
 * record to find (no settings file, no hook, an unreadable store), this
 * collapses back to exactly the `page.idle` path that was here before.
 */
async function readSession(name: string, cursor: number): Promise<RpcResult> {
  const session = await getLiveOrAdopt(name)
  if (!session) {
    // Not live: nothing to stream. idle:true so a poll loop terminates cleanly.
    return ok({ text: '', cursor, idle: true, live: false })
  }
  try {
    const page = await session.read({ cursor })
    const ledger = defaultTurnLedger()
    // Only ask the backend for an identity when something is going to use one.
    const identity = page.idle || session.engine === 'claude' ? await agentIdentityOf(session) : undefined
    const ended: ClaudeTurnEnd | undefined =
      identity !== undefined && session.engine === 'claude'
        ? claudeTurnEndAfter(ledger.pendingBaseline(name, identity))
        : undefined

    if (ended && identity !== undefined) {
      // Claude stated the turn is over. Take the ledger's claim so this is
      // reported exactly once however many polls observe the same record, and
      // report `idle: true` regardless of what the pane still says — the whole
      // point is that a stale `working` no longer keeps a poll loop running.
      const base = {
        ...page,
        idle: true,
        live: true,
        engine: session.engine,
        attachHint: session.attachHint(),
        turnEnded: ended.kind,
      }
      if (ended.kind === 'stop') {
        const ref = ledger.completeTurn(name, identity)
        if (ref) {
          emitCompletion({
            type: 'session',
            id: name,
            cursor: page.cursor,
            // Claude's own last message beats a summary of scraped pane text.
            summary: summarize(ended.message ?? page.text),
            cwd: session.cwd,
            turn: turnOf(session, ref),
          })
        }
        return ok({
          ...base,
          ...(ended.message ? { finalMessage: ended.message } : {}),
          ...(ended.messageTruncated ? { finalMessageTruncated: true } : {}),
        })
      }
      // StopFailure is TERMINAL and needs review: the turn is over and it did
      // not succeed. It is not a completion, so it never reports one — the turn
      // is closed out with abortTurn (once) and recorded as an error, which is
      // a transition the foreman inbox surfaces for attention.
      const ref = ledger.abortTurn(name, identity)
      if (ref) {
        emitLifecycle({
          type: 'session',
          id: name,
          kind: 'error',
          reason: 'Claude reported StopFailure: the turn ended in failure and needs review',
          turn: turnOf(session, ref),
        })
      }
      return ok(base)
    }

    if (page.idle && identity !== undefined) {
      const ref = ledger.completeTurn(name, identity)
      if (ref) {
        emitCompletion({
          type: 'session',
          id: name,
          cursor: page.cursor,
          summary: summarize(page.text),
          cwd: session.cwd,
          turn: turnOf(session, ref),
        })
      }
    }
    return ok({ ...page, live: true, engine: session.engine, attachHint: session.attachHint() })
  } catch (e) {
    return err(500, `read failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleRead(name: string, req: RpcRequest): Promise<RpcResult> {
  const cursor = req.query.get('cursor') ? Number(req.query.get('cursor')) : 0
  return readSession(name, cursor)
}

async function handleInterrupt(name: string): Promise<RpcResult> {
  const session = await getLiveOrAdopt(name)
  if (!session) return err(409, `session "${name}" is not live`)
  audit({ route: 'POST /sessions/:name/interrupt', name, engine: session.engine, cwd: session.cwd })
  await session.interrupt()
  // The turn in flight is over and will never complete. Close it out so no
  // later poll reports it as finished, and record the transition — a foreman
  // resuming after a context loss needs to know this turn was cut short rather
  // than silently assume the instruction is still running.
  const identity = await agentIdentityOf(session)
  const ref = defaultTurnLedger().abortTurn(name, identity)
  if (ref) {
    emitLifecycle({
      type: 'session',
      id: name,
      kind: 'interrupted',
      reason: 'interrupted by the caller',
      turn: turnOf(session, ref),
    })
  }
  return ok({ ok: true, name, engine: session.engine })
}

async function handleClose(name: string): Promise<RpcResult> {
  // Not in this process's registry does NOT mean gone. A session that
  // survived a bridge restart is exactly what open_session re-adopts through
  // the backend, and closing it has to take the same path — otherwise the
  // caller is told `alreadyClosed` while the terminal keeps running, which
  // under Herdr leaves a visible workspace nobody can address any more.
  //
  // Measured 2026-08-29: six such workspaces had accumulated from earlier
  // proof runs, each reported closed and each still live.
  //
  // getLiveOrAdopt re-validates ownership tags and the cwd allowlist on
  // adoption, so this can only ever close a session this installation owns,
  // and shares its result with any concurrent send/read/interrupt racing to
  // adopt the same not-yet-registered name.
  const session = await getLiveOrAdopt(name)
  if (!session) {
    // Nothing this installation owns answers to that name, or it's owned
    // but its cwd is no longer admissible so it is not ours to drive.
    // Idempotent either way.
    return ok({ ok: true, name, alreadyClosed: true })
  }
  audit({ route: 'POST /sessions/:name/close', name, engine: session.engine, cwd: session.cwd })
  // Take the session coordinate BEFORE closing, while the backend can still
  // report its identity. The ledger entry is deliberately KEPT after a close:
  // it is what stops a session reopened under the same name from reusing this
  // incarnation's event ids.
  const identity = await agentIdentityOf(session)
  const ref = defaultTurnLedger().sessionRef(name, identity)
  await session.close()
  unregisterLive(name)
  emitLifecycle({ type: 'session', id: name, kind: 'closed', turn: turnOf(session, ref) })
  return ok({ ok: true, name, engine: session.engine })
}

// ---- relay handlers -------------------------------------------------------

async function handleRelayStart(req: RpcRequest): Promise<RpcResult> {
  const goal = String(req.body['goal'] ?? '')
  if (!goal) return err(400, 'goal is required')
  const cwdInput = req.body['cwd'] !== undefined ? String(req.body['cwd']) : DEFAULT_CWD
  if (!isCwdAllowed(cwdInput, ALLOWLIST)) return err(403, `cwd not allowed: ${cwdInput}`)
  const cwd = safeResolve(cwdInput)
  const maxTurns = req.body['maxTurns'] !== undefined ? Number(req.body['maxTurns']) : undefined
  const context = req.body['context'] !== undefined ? String(req.body['context']) : undefined

  audit({ route: 'POST /relay/start', cwd, goal })
  try {
    const { loopId, leadName, workerName } = await relay.startRelay({
      goal,
      cwd,
      maxTurns,
      context,
      allowlist: ALLOWLIST,
    })
    return ok({ status: 'running', loopId, leadName, workerName, cursor: 0 })
  } catch (e) {
    if (e instanceof relay.RelayConfigError) return err(400, e.message)
    return err(500, `failed to start relay: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function handleRelayRead(loopId: string, req: RpcRequest): RpcResult {
  const cursor = req.query.get('cursor') ? Number(req.query.get('cursor')) : 0
  const page = relay.readSince(loopId, cursor)
  if (!page) return err(404, `unknown loopId: ${loopId}`)
  return ok(page)
}
