/**
 * router.ts — local RPC router (the TRUST BOUNDARY).
 *
 * Adapted from the original cloud-code-mcp bridge. The Worker/WebSocket tunnel
 * transport has been removed: in tandem the MCP HTTP server (src/http-mcp.ts)
 * calls `route()` DIRECTLY in-process. Everything below — the route table,
 * handlers, name validation, relay-owned isolation, cwd allowlist enforcement,
 * and the audit log — is unchanged from the proven original.
 *
 * ENGINE = tmux. Every drivable "session" is a REAL interactive `claude` TUI in
 * a tmux session "ccm-<name>", spawned and driven by TerminalSession via
 * keystroke injection + pane scraping. We NEVER run `claude -p` / headless and
 * NEVER set ANTHROPIC_API_KEY, so usage stays on the user's interactive
 * subscription. The autonomous capability is the zero-API two-session relay.
 *
 * SECURITY RAILS:
 *   - cwd ALLOWLIST (buildAllowlist / isCwdAllowed / safeResolve from
 *     sessions.ts). Any cwd outside the allowlist is rejected with a clean 403.
 *     Paths are realpath-canonicalized before the check so `..` / symlink escapes
 *     can't slip through, and the prefix comparison uses a trailing separator so
 *     "/Users/max" does NOT match "/Users/maxfoo".
 *   - Only ccm-* tmux sessions are drivable.
 *   - tmux send-keys is injection-safe (-l literal + -- end-of-options).
 *   - Audit log: every spawn / send / interrupt / close / relay control appends a
 *     line to ~/.tandem/bridge.log. A failed audit write surfaces to stderr.
 *
 * Config (env): TANDEM_CWD_ALLOWLIST / TANDEM_DEFAULT_CWD are mapped to the
 * engine's CCM_* names by the entrypoint before this module loads.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TerminalSession } from './terminal-session.ts'
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

// ---- config ---------------------------------------------------------------

const HOME = homedir()
const DEFAULT_CWD = process.env.CCM_DEFAULT_CWD ?? HOME
const BRIDGE_LOG = join(HOME, '.tandem', 'bridge.log')

/** The allowlist is built once from env (or the $HOME default) at startup. */
const ALLOWLIST = buildAllowlist()

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

function audit(fields: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n'
  try {
    mkdirSync(join(HOME, '.tandem'), { recursive: true })
    appendFileSync(BRIDGE_LOG, line)
  } catch (e) {
    // Do NOT silently swallow: surface to stderr so a broken audit trail is visible.
    process.stderr.write(
      `[bridge] AUDIT WRITE FAILED (${e instanceof Error ? e.message : String(e)}): ${line}`,
    )
  }
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
    return ok(await listSessions({ limit, project }))
  }

  // POST /sessions/open
  if (m === 'POST' && parts.length === 2 && parts[0] === 'sessions' && parts[1] === 'open') {
    return handleOpen(req)
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
  }

  return err(404, `no route for ${m} ${req.path}`)
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
  const cwdInput = req.body['cwd'] !== undefined ? String(req.body['cwd']) : DEFAULT_CWD
  if (!isCwdAllowed(cwdInput, ALLOWLIST)) {
    return err(403, `cwd not allowed: ${cwdInput}`)
  }
  const cwd = safeResolve(cwdInput)

  // Idempotent: reuse a session already live under this name.
  const existing = getLive(name)
  if (existing) {
    audit({ route: 'POST /sessions/open', name, cwd, reused: true })
    return ok({ name: existing.name, cwd: existing.cwd, attachHint: existing.attachHint(), reused: true })
  }
  // Re-adopt a ccm-* session that survived a bridge restart (re-validates cwd).
  const adopted = await TerminalSession.attachExisting(name, ALLOWLIST)
  if (adopted) {
    registerLive(adopted)
    audit({ route: 'POST /sessions/open', name, cwd: adopted.cwd, adopted: true })
    return ok({ name: adopted.name, cwd: adopted.cwd, attachHint: adopted.attachHint(), reused: true })
  }
  if (await TerminalSession.exists(name)) {
    audit({ route: 'POST /sessions/open', name, denied: 'adopt-cwd-not-allowed' })
    return err(403, `existing session "${name}" has a cwd outside the allowlist; refusing to adopt`)
  }

  try {
    const session = await TerminalSession.spawn({ name, cwd, allowlist: ALLOWLIST })
    registerLive(session)
    audit({ route: 'POST /sessions/open', name: session.name, cwd })
    return ok({ name: session.name, cwd: session.cwd, attachHint: session.attachHint() })
  } catch (e) {
    return err(500, `failed to open session: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleSend(name: string, req: RpcRequest): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) return err(409, `session "${name}" is not live; call open_session first`)
  const text = String(req.body['text'] ?? '')
  if (!text) return err(400, 'text is required')
  audit({ route: 'POST /sessions/:name/send', name, cwd: session.cwd, text })

  try {
    const result = await session.send(text)
    return ok({
      status: result.status,
      name,
      report: result.report,
      cursor: result.cursor,
      attachHint: session.attachHint(),
    })
  } catch (e) {
    return err(500, `send failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleRead(name: string, req: RpcRequest): Promise<RpcResult> {
  const session = getLive(name)
  const cursor = req.query.get('cursor') ? Number(req.query.get('cursor')) : 0
  if (!session) {
    // Not live: nothing to stream. idle:true so a poll loop terminates cleanly.
    return ok({ text: '', cursor, idle: true, live: false })
  }
  try {
    const page = await session.readSince(cursor)
    return ok({ ...page, live: true, attachHint: session.attachHint() })
  } catch (e) {
    return err(500, `read failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function handleInterrupt(name: string): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) return err(409, `session "${name}" is not live`)
  audit({ route: 'POST /sessions/:name/interrupt', name, cwd: session.cwd })
  await session.interrupt()
  return ok({ ok: true, name })
}

async function handleClose(name: string): Promise<RpcResult> {
  const session = getLive(name)
  if (!session) {
    // Already gone is success (idempotent).
    return ok({ ok: true, name, alreadyClosed: true })
  }
  audit({ route: 'POST /sessions/:name/close', name, cwd: session.cwd })
  await session.close()
  unregisterLive(name)
  return ok({ ok: true, name })
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
    return err(500, `failed to start relay: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function handleRelayRead(loopId: string, req: RpcRequest): RpcResult {
  const cursor = req.query.get('cursor') ? Number(req.query.get('cursor')) : 0
  const page = relay.readSince(loopId, cursor)
  if (!page) return err(404, `unknown loopId: ${loopId}`)
  return ok(page)
}
