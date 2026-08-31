/**
 * Native Herdr lifecycle for Tandem's interactive Claude and Codex engines.
 *
 * Herdr remains the authoritative runtime: Tandem creates a no-focus workspace,
 * starts an agent in its root pane, reads semantic status/revisions, submits
 * prompts, interrupts with Herdr keys, and closes only its own tagged workspace.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { delimiter as pathDelimiter, isAbsolute } from 'node:path'
import type { EngineId } from './drivable.ts'
import type { TerminalSessionLike } from './engines/terminal-adapter.ts'
import { claudeWorkerArgv, claudeWorkerEnvironment, claudeWorkerSpawn, type ClaudeWorkerSpawn } from './claude-worker-env.ts'
import { isCwdAllowed, safeResolve } from './cwd-allowlist.ts'
import { FileHerdrCursorStore, type HerdrCursorState, type HerdrCursorStore, type HerdrSessionIdentity }
  from './herdr-cursor-store.ts'
import { ensureHerdrSessionSocket, herdrAttachPrefix } from './herdr-session.ts'
import { makeOwnerIdProvider, type OwnerIdProvider } from './ownership.ts'

const OWNER_TOKEN = 'tandem_owner'
const NAME_TOKEN = 'tandem_session'
const ENGINE_TOKEN = 'tandem_engine'
const AGENT_TOKEN = 'tandem_agent'
const METADATA_SOURCE = 'tandem'
const MAX_WIRE_BYTES = 16 * 1024 * 1024
const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/
const CLAUDE_TRUST_PROMPT_MARKER = 'trust this folder'
const CLAUDE_BYPASS_PROMPT_MARKER = 'yes, i accept'
const CODEX_TRUST_PROMPT_MARKER = 'do you trust the contents of this directory?'
const CODEX_TRUST_CONFIRM_MARKER = 'yes, continue'
const SEND_SOFT_CAP_MS = Number(process.env.TANDEM_WAIT_MS) > 0
  ? Number(process.env.TANDEM_WAIT_MS)
  : 25_000

export type HerdrEngineId = Extract<EngineId, 'claude' | 'codex'>
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface HerdrAgentSessionRef {
  source: string
  agent: string
  kind: 'id' | 'path'
  value: string
}

export interface HerdrAgentInfo {
  terminal_id: string
  name?: string
  agent?: string
  agent_status: HerdrAgentStatus
  agent_session?: HerdrAgentSessionRef
  workspace_id: string
  tab_id: string
  pane_id: string
  launch_pending?: boolean
  interactive_ready?: boolean
  cwd?: string
  foreground_cwd?: string
  revision: number
  /** Herdr's monotonic count of OBSERVED lifecycle transitions for this agent.
   *  This — not `agent_status` alone — is what distinguishes "the turn I just
   *  submitted has finished" from "Herdr has not noticed my turn started yet
   *  and is still reporting the PREVIOUS turn's settled state". Optional in
   *  Herdr's schema (`default: 0`), so every use degrades to status-only
   *  behavior when it is absent. */
  state_change_seq?: number
}

interface HerdrWorkspaceInfo {
  workspace_id: string
  tokens?: Record<string, string>
}

interface HerdrPaneInfo {
  pane_id: string
}

interface HerdrReadResult {
  text: string
  revision: number
}

interface HerdrPaneProcessInfo {
  shell_pid?: number
  foreground_process_group_id?: number
  foreground_processes?: Array<{ pid?: number; name?: string; argv?: string[] }>
}

export interface HerdrApiClient {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

export class HerdrApiError extends Error {
  readonly code: string

  constructor(
    code: string,
    message: string,
  ) {
    super(message)
    this.code = code
  }
}

/** Optional PATH applied only to Tandem-owned Herdr workspaces. */
export function herdrWorkspaceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const configured = env.TANDEM_HERDR_WORKSPACE_PATH?.trim()
  if (!configured) return {}
  const entries = configured.split(pathDelimiter)
  if (entries.some((entry) => !entry || !isAbsolute(entry))) {
    throw new Error('TANDEM_HERDR_WORKSPACE_PATH must contain only absolute directories')
  }
  return { PATH: entries.join(pathDelimiter) }
}

/** One request per local socket connection, matching Herdr's documented wire protocol. */
export class SocketHerdrApiClient implements HerdrApiClient {
  private readonly resolveSocketPath: () => Promise<string>
  /** Resolved once per client, on the FIRST call: constructing a client (which
   *  happens as a default parameter, at import time for the process-wide
   *  backend) must not start Tandem's Herdr session as a side effect, nor
   *  leave a rejected promise nobody awaited. */
  private socketPath: Promise<string> | undefined

  constructor(socketPath: Promise<string> | (() => Promise<string>) = () => ensureHerdrSessionSocket()) {
    this.resolveSocketPath = typeof socketPath === 'function' ? socketPath : () => socketPath
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    this.socketPath ??= this.resolveSocketPath()
    const socketPath = await this.socketPath
    const info = await lstat(socketPath)
    if (!info.isSocket()) throw new Error('configured Herdr API path is not a Unix socket')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error('configured Herdr API socket has the wrong owner')
    }
    const requestId = `tandem-${randomUUID()}`
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(socketPath)
      let settled = false
      let wire = ''
      const finish = (error?: Error, result?: Record<string, unknown>) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (error) reject(error)
        else resolve(result ?? {})
      }
      socket.setEncoding('utf8')
      socket.setTimeout(timeoutMs, () => finish(new HerdrApiError('timeout', `Herdr ${method} timed out`)))
      socket.once('error', (error) => finish(new Error(`Herdr ${method} socket error: ${error.message}`)))
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
      })
      socket.on('data', (chunk: string) => {
        wire += chunk
        if (wire.length > MAX_WIRE_BYTES) {
          finish(new Error(`Herdr ${method} response exceeded the size limit`))
          return
        }
        const newline = wire.indexOf('\n')
        if (newline === -1) return
        try {
          const response = JSON.parse(wire.slice(0, newline)) as {
            id?: string
            result?: Record<string, unknown>
            error?: { code?: string; message?: string }
          }
          if (response.id !== requestId) throw new Error('Herdr response id did not match the request')
          if (response.error) {
            finish(new HerdrApiError(response.error.code ?? 'herdr_error', response.error.message ?? 'Herdr request failed'))
            return
          }
          if (!response.result || typeof response.result !== 'object') {
            throw new Error('Herdr response did not contain a result')
          }
          finish(undefined, response.result)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.once('end', () => finish(new Error(`Herdr ${method} closed without a response`)))
    })
  }
}

function resultObject<T>(result: Record<string, unknown>, key: string): T {
  const value = result[key]
  if (!value || typeof value !== 'object') throw new Error(`Herdr response omitted ${key}`)
  return value as T
}

function resultArray<T>(result: Record<string, unknown>, key: string): T[] {
  const value = result[key]
  if (!Array.isArray(value)) throw new Error(`Herdr response omitted ${key}`)
  return value as T[]
}

function agentNameFor(name: string): string {
  return `tandem-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
}

/** The exact agent a stored cursor belongs to (see herdr-cursor-store.ts). */
function identityOf(workspaceId: string, agent: HerdrAgentInfo): HerdrSessionIdentity {
  return { workspaceId, terminalId: agent.terminal_id }
}

function agentCwd(agent: HerdrAgentInfo): string | undefined {
  return agent.foreground_cwd || agent.cwd
}

function agentTarget(agent: HerdrAgentInfo): string {
  return agent.name || agent.pane_id
}

function isSettled(status: HerdrAgentStatus): boolean {
  return status === 'idle' || status === 'done' || status === 'blocked'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Window lines kept for read-to-read diffing (see newLinesAfterWindow). */
const MAX_TRACKED_LINES = 600
/** Emitted transcript kept for cursor replay. */
const MAX_REPLAY_CHARS = 256 * 1024
/** Lines requested per scrollback read. */
const READ_LINES = 160

function splitLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(/\s+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  while (lines.length && lines[0] === '') lines.shift()
  return lines
}

/**
 * The lines of `incoming` that are genuinely NEW relative to `previous`.
 *
 * A Herdr read is a WINDOW over the pane, never a delta: two consecutive reads
 * of a session that produced three new lines repeat everything else. Reporting
 * the window verbatim is what makes a second turn re-deliver the first turn's
 * answer.
 *
 * The window is also not an append-only transcript. An agent TUI redraws IN
 * PLACE, so a turn's new output arrives in the MIDDLE of the window, between a
 * stable head (banner, earlier turns) and a stable tail (the input box and
 * status footer, which are on screen the whole time). Live-measured against
 * Claude Code 2.1.251 under Herdr: consecutive reads shared a 9-line head and
 * a 6-line tail with the new answer inserted between them, which is why a
 * suffix-of-previous/prefix-of-incoming overlap test found NO overlap at all
 * and re-delivered the entire screen, `LIVE_LONG_TURN_OK` included.
 *
 * So this is a diff, not an overlap: align the two windows on their longest
 * common subsequence and report only the insertions. Lines that scrolled out
 * of the window, lines that changed in place, and lines appended at the end
 * all fall out of that correctly, and a window with nothing in common (the
 * screen was replaced, or the pane scrolled further than the window) is
 * reported in full — duplicating output is recoverable for a reader, silently
 * dropping it is not.
 */
function newLinesAfterWindow(previous: string[], incoming: string[]): string[] {
  if (!incoming.length) return []
  if (!previous.length) return incoming
  const rows = previous.length
  const columns = incoming.length
  // lcs[i][j] = length of the longest common subsequence of previous[i..] and
  // incoming[j..]. Both sides are bounded by MAX_TRACKED_LINES/READ_LINES.
  const lcs: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      lcs[i][j] = previous[i] === incoming[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const added: string[] = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (previous[i] === incoming[j]) {
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++
    } else {
      added.push(incoming[j])
      j++
    }
  }
  for (; j < columns; j++) added.push(incoming[j])
  return added
}

const MAX_MENU_CURSOR_MOVES = 8

/**
 * Key sequence to select `targetMarker`'s line in an arrow-cursor menu prompt
 * (Claude Code's folder-trust screen renders one option per line, prefixed
 * with `❯` on whichever is currently highlighted). Live-confirmed against
 * Claude Code 2.1.251: this screen defaults the cursor to "No, exit", not
 * "Yes, I trust this folder" as an earlier version's screen did — a blind
 * `enter` selects "No, exit" and the agent exits immediately (observed:
 * `agent.get` then fails with `agent_not_found`, pane exits with status 1).
 * Falls back to a plain `['enter']` when no `❯` cursor line is found at all
 * (e.g. Codex's numbered, non-arrow-cursor trust prompt), preserving prior
 * behavior for that case exactly.
 */
function lastLineIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (predicate(lines[i])) return i
  }
  return -1
}

function menuConfirmKeys(text: string, targetMarker: string): string[] {
  const lines = text.split('\n')
  // The LAST `❯` in the scrollback is the live menu cursor: recent_unwrapped
  // also carries earlier terminal history (e.g. the shell's own `❯ claude`
  // prompt used to launch the agent, which is not the TUI menu and sorts
  // BEFORE it) — live-confirmed this false-matches on the first `❯` and
  // computes zero moves, selecting whatever the shell-echo line happened to
  // align with.
  const cursorIndex = lastLineIndex(lines, (line) => line.includes('❯'))
  if (cursorIndex === -1) return ['enter']
  const targetIndex = lastLineIndex(lines, (line) => line.toLowerCase().includes(targetMarker))
  if (targetIndex === -1) return ['enter']
  const delta = targetIndex - cursorIndex
  if (delta === 0) return ['enter']
  const moves = Math.min(Math.abs(delta), MAX_MENU_CURSOR_MOVES)
  return [...Array(moves).fill(delta > 0 ? 'down' : 'up'), 'enter']
}

function processInfoShowsShellInitialization(info: HerdrPaneProcessInfo): boolean {
  if (!info.shell_pid || info.foreground_process_group_id !== info.shell_pid) return false
  return Boolean(info.foreground_processes?.some((process) => {
    if (process.pid !== info.shell_pid) return false
    const name = process.name ?? process.argv?.[0] ?? ''
    return /(?:^|\/)(?:ba|z|fi|da|k)?sh$/i.test(name)
  }))
}

async function startAgentAfterShellReady(
  client: HerdrApiClient,
  params: Record<string, unknown>,
): Promise<HerdrAgentInfo> {
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      const started = await client.call('agent.start', params, 70_000)
      return resultObject<HerdrAgentInfo>(started, 'agent')
    } catch (error) {
      if (!(error instanceof HerdrApiError) || error.code !== 'agent_pane_busy' || Date.now() >= deadline) throw error
      const processResult = await client.call('pane.process_info', { pane_id: params.pane_id })
      const processInfo = resultObject<HerdrPaneProcessInfo>(processResult, 'process_info')
      if (!processInfoShowsShellInitialization(processInfo)) throw error
      await sleep(100)
    }
  }
}

async function waitForInteractiveAgent(
  client: HerdrApiClient,
  initial: HerdrAgentInfo,
  engine: HerdrEngineId,
  timeoutMs = 60_000,
): Promise<HerdrAgentInfo> {
  const deadline = Date.now() + timeoutMs
  let current = initial
  let trustConfirmed = false
  while (Date.now() < deadline) {
    if (current.interactive_ready && !current.launch_pending && current.agent === engine) return current
    if (current.agent_status === 'blocked') {
      const target = agentTarget(current)
      // `blocked` is NOT reliably scrollback-readable: recent_unwrapped can
      // fail against a blocked alternate-screen agent (live-reproduced
      // against a blocked Herdr agent). `visible` reads the live viewport
      // instead and is what a blocked startup screen (trust/bypass prompts)
      // always needs anyway — the prompt is on-screen right now.
      const readResult = await client.call('agent.read', {
        target,
        source: 'visible',
        format: 'text',
        strip_ansi: true,
      })
      const read = resultObject<HerdrReadResult>(readResult, 'read')
      const lower = read.text.toLowerCase()
      const claudeTrust = engine === 'claude' && lower.includes(CLAUDE_TRUST_PROMPT_MARKER)
      const codexTrust = engine === 'codex' &&
        lower.includes(CODEX_TRUST_PROMPT_MARKER) &&
        lower.includes(CODEX_TRUST_CONFIRM_MARKER)
      if (!trustConfirmed && (claudeTrust || codexTrust)) {
        // Same narrow first-run behavior as the upstream tmux backend: the cwd
        // already passed the canonical allowlist twice, so confirm the default
        // trust choice through Herdr's native key API. For an arrow-cursor menu
        // (Claude Code), navigate to whichever line is actually the trust
        // option rather than assuming it is already highlighted — see
        // menuConfirmKeys.
        const keys = claudeTrust ? menuConfirmKeys(read.text, CLAUDE_TRUST_PROMPT_MARKER) : ['enter']
        await client.call('agent.send_keys', { target, keys })
        trustConfirmed = true
        await sleep(500)
      } else if (engine === 'claude' && lower.includes(CLAUDE_BYPASS_PROMPT_MARKER)) {
        throw new Error('Claude requested permission-bypass acceptance; refusing because bypass is disabled')
      } else {
        throw new Error(`Herdr ${engine} agent is blocked during startup and needs human input`)
      }
    } else {
      await sleep(200)
    }
    const result = await client.call('agent.get', { target: agentTarget(initial) })
    current = resultObject<HerdrAgentInfo>(result, 'agent')
  }
  throw new Error(`Herdr ${engine} agent did not reach interactive readiness`)
}

export interface OwnedHerdrSession {
  name: string
  engine: HerdrEngineId
  cwd: string
  updatedAt: number
  workspaceId: string
  agent: HerdrAgentInfo
}

/** Enumerate only workspaces tagged with this Tandem installation's owner id. */
export async function listOwnedHerdrSessions(
  client: HerdrApiClient,
  ownerIdProvider: OwnerIdProvider = makeOwnerIdProvider(),
): Promise<OwnedHerdrSession[]> {
  const [workspaceResult, agentResult, owner] = await Promise.all([
    client.call('workspace.list'),
    client.call('agent.list'),
    ownerIdProvider(),
  ])
  const workspaces = resultArray<HerdrWorkspaceInfo>(workspaceResult, 'workspaces')
  const agents = resultArray<HerdrAgentInfo>(agentResult, 'agents')
  const out: OwnedHerdrSession[] = []
  for (const workspace of workspaces) {
    const tokens = workspace.tokens ?? {}
    if (tokens[OWNER_TOKEN] !== owner) continue
    const name = tokens[NAME_TOKEN]
    const engine = tokens[ENGINE_TOKEN]
    const expectedAgent = tokens[AGENT_TOKEN]
    if (!name || !SESSION_NAME_RE.test(name)) continue
    if (engine !== 'claude' && engine !== 'codex') continue
    const agent = agents.find(
      (candidate) => candidate.workspace_id === workspace.workspace_id &&
        (!expectedAgent || candidate.name === expectedAgent),
    )
    const cwd = agent && agentCwd(agent)
    if (!agent || !cwd) continue
    out.push({
      name,
      engine,
      cwd: safeResolve(cwd),
      updatedAt: Number(agent.revision) || Date.now(),
      workspaceId: workspace.workspace_id,
      agent,
    })
  }
  return out
}

export interface HerdrSpawnOptions {
  name: string
  engine: HerdrEngineId
  cwd: string
  allowlist: string[]
  model?: string
  effort?: string
  ownerIdProvider?: OwnerIdProvider
}

export class HerdrTerminalSession implements TerminalSessionLike {
  readonly name: string
  readonly cwd: string
  readonly ready: boolean
  readonly readinessWarning: string | undefined
  readonly engine: HerdrEngineId
  readonly workspaceId: string
  private agent: HerdrAgentInfo
  private readonly client: HerdrApiClient
  private readonly ownerIdProvider: OwnerIdProvider
  /**
   * CURSOR. Herdr's own `read.revision` is NOT a usable cursor: it is 0 on
   * every read of an agent pane (live-measured against Herdr 0.8.2 —
   * recent_unwrapped, visible, detection and pane.read all return revision 0
   * for every live agent on this machine). Using it as the cursor made
   * `readSince` compare `0 > 0` and report NOTHING, forever: every turn that
   * outlived the send soft cap was invisible to the polling caller.
   *
   * So the cursor is Tandem's own, and monotonic: it increments once per
   * chunk of newly-observed output. `emitted` keeps those chunks (bounded) so
   * a caller polling with an older cursor is served the same bytes again,
   * which is the contract the tmux backend's byte-offset cursor already has.
   *
   * All three survive a bridge restart through the cursor store: a cold
   * re-adoption resumes the same counter, the same replay history, and the
   * same de-duplication window, so a caller cannot be handed a cursor lower
   * than the one it already holds, cannot be re-served output it consumed,
   * and can still collect output produced while the bridge was down.
   */
  private cursorValue = 0
  private emitted: Array<{ cursor: number; text: string }> = []
  /** The previous read's window, which the next one is diffed against — see
   *  newLinesAfterWindow. */
  private lastWindow: string[] = []
  private readonly store: HerdrCursorStore
  private readonly stateKey: string
  /** `state_change_seq` at the last scrollback read, so an unchanged, settled
   *  agent is not re-read on every poll. */
  private lastReadSeq: number | undefined
  /** The turn submitted by send() and not yet observed to have produced its
   *  own settled state. While one is in flight, a settled status that Herdr
   *  has not moved past yet is reported as still running — see turnSettled. */
  private pendingTurn: { submittedSeq: number | undefined; hadBaseline: boolean } | undefined

  private constructor(
    owned: OwnedHerdrSession,
    client: HerdrApiClient,
    ownerIdProvider: OwnerIdProvider,
    store: HerdrCursorStore,
    restored?: HerdrCursorState,
  ) {
    this.name = owned.name
    this.engine = owned.engine
    this.cwd = owned.cwd
    this.workspaceId = owned.workspaceId
    this.agent = owned.agent
    this.client = client
    this.ownerIdProvider = ownerIdProvider
    this.store = store
    this.stateKey = agentNameFor(owned.name)
    if (restored) {
      this.cursorValue = restored.cursor
      this.emitted = restored.chunks
      this.lastWindow = restored.window
    }
    this.ready = Boolean(owned.agent.interactive_ready && !owned.agent.launch_pending)
    this.readinessWarning = this.ready
      ? undefined
      : 'Herdr started the agent but it has not reported interactive readiness yet.'
  }

  static async spawn(
    opts: HerdrSpawnOptions,
    client: HerdrApiClient = new SocketHerdrApiClient(),
    store: HerdrCursorStore = new FileHerdrCursorStore(),
  ): Promise<HerdrTerminalSession> {
    if (!SESSION_NAME_RE.test(opts.name)) throw new Error(`invalid session name: ${opts.name}`)
    if (opts.engine !== 'claude' && opts.engine !== 'codex') {
      throw new Error(`Herdr backend does not support engine "${opts.engine}"`)
    }
    if (opts.engine !== 'claude' && (opts.model !== undefined || opts.effort !== undefined)) {
      throw new Error('model/effort are Claude-only options')
    }
    if (!isCwdAllowed(opts.cwd, opts.allowlist)) throw new Error(`cwd not allowed: ${opts.cwd}`)
    const cwd = safeResolve(opts.cwd)
    if (!isCwdAllowed(cwd, opts.allowlist)) throw new Error(`cwd not allowed: ${opts.cwd}`)
    // Tandem-owned Claude workers only, and only when the host configured a
    // settings file: the lifecycle hook's registration and the opaque identity
    // it stamps records with. Resolved BEFORE the workspace exists so a
    // misconfigured path fails without leaving one behind.
    const claudeWorker: ClaudeWorkerSpawn | undefined =
      opts.engine === 'claude' ? claudeWorkerSpawn(opts.name) : undefined
    const ownerIdProvider = opts.ownerIdProvider ?? makeOwnerIdProvider()
    const owner = await ownerIdProvider()
    const agentName = agentNameFor(opts.name)
    const created = await client.call('workspace.create', {
      cwd,
      focus: false,
      label: `Tandem ${opts.name}`,
      env: { ...herdrWorkspaceEnvironment(), ...claudeWorkerEnvironment(claudeWorker) },
    })
    const workspace = resultObject<HerdrWorkspaceInfo>(created, 'workspace')
    const rootPane = resultObject<HerdrPaneInfo>(created, 'root_pane')
    try {
      await client.call('workspace.report_metadata', {
        workspace_id: workspace.workspace_id,
        source: METADATA_SOURCE,
        tokens: {
          [OWNER_TOKEN]: owner,
          [NAME_TOKEN]: opts.name,
          [ENGINE_TOKEN]: opts.engine,
          [AGENT_TOKEN]: agentName,
        },
        seq: 1,
      })
      const args: string[] = []
      args.push(...claudeWorkerArgv(claudeWorker))
      if (opts.engine === 'claude' && opts.model) args.push('--model', opts.model)
      if (opts.engine === 'claude' && opts.effort) args.push('--effort', opts.effort)
      const started = await startAgentAfterShellReady(client, {
        name: agentName,
        kind: opts.engine,
        pane_id: rootPane.pane_id,
        args,
        timeout_ms: 60_000,
      })
      const agent = await waitForInteractiveAgent(client, started, opts.engine)
      if (agent.workspace_id !== workspace.workspace_id) {
        throw new Error('Herdr started the agent in an unexpected workspace')
      }
      // A NEW agent starts with no transcript. Any state still on disk under
      // this name describes a session that no longer exists, and inheriting it
      // would report output this agent never produced.
      await store.clear(agentNameFor(opts.name)).catch(() => {})
      return new HerdrTerminalSession({
        name: opts.name,
        engine: opts.engine,
        cwd,
        updatedAt: Number(agent.revision) || Date.now(),
        workspaceId: workspace.workspace_id,
        agent,
      }, client, ownerIdProvider, store)
    } catch (error) {
      await client.call('workspace.close', { workspace_id: workspace.workspace_id }).catch(() => {})
      throw error
    }
  }

  static async attachExisting(
    name: string,
    engine: HerdrEngineId,
    allowlist: string[],
    client: HerdrApiClient = new SocketHerdrApiClient(),
    ownerIdProvider: OwnerIdProvider = makeOwnerIdProvider(),
    store: HerdrCursorStore = new FileHerdrCursorStore(),
  ): Promise<HerdrTerminalSession | undefined> {
    const owned = (await listOwnedHerdrSessions(client, ownerIdProvider))
      .find((session) => session.name === name && session.engine === engine)
    if (!owned || !isCwdAllowed(owned.cwd, allowlist)) return undefined
    const canonical = safeResolve(owned.cwd)
    if (!isCwdAllowed(canonical, allowlist)) return undefined
    // Cold re-adoption after a bridge restart: resume this session's cursor,
    // replay history, and de-duplication window if the stored state still
    // describes THIS agent. Anything else is ignored, and the session simply
    // starts its bookkeeping over.
    const restored = await store
      .load(agentNameFor(name), identityOf(owned.workspaceId, owned.agent))
      .catch(() => undefined)
    return new HerdrTerminalSession({ ...owned, cwd: canonical }, client, ownerIdProvider, store, restored)
  }

  static async engineTagOf(
    name: string,
    client: HerdrApiClient = new SocketHerdrApiClient(),
    ownerIdProvider: OwnerIdProvider = makeOwnerIdProvider(),
  ): Promise<HerdrEngineId | undefined> {
    return (await listOwnedHerdrSessions(client, ownerIdProvider)).find((session) => session.name === name)?.engine
  }

  static async exists(
    name: string,
    client: HerdrApiClient = new SocketHerdrApiClient(),
    ownerIdProvider: OwnerIdProvider = makeOwnerIdProvider(),
  ): Promise<boolean> {
    return (await listOwnedHerdrSessions(client, ownerIdProvider)).some((session) => session.name === name)
  }

  attachHint(): string {
    return `${herdrAttachPrefix()} agent attach ${agentTarget(this.agent)}`
  }

  /**
   * A stable identity for THIS incarnation of the session, used by
   * bridge/turn-ledger.ts. The workspace and terminal ids are exactly the pair
   * herdr-cursor-store.ts already treats as "the same agent" when deciding
   * whether restored cursor state may be trusted, so the two agree by
   * construction: a Tandem name reopened onto a new Herdr agent gets a new
   * identity here and a new turn epoch, and cannot inherit the old agent's
   * event ids.
   */
  async agentIdentity(): Promise<string | undefined> {
    return `herdr:${this.workspaceId}:${this.agent.terminal_id}`
  }

  nativeSessionRef(): HerdrAgentSessionRef | undefined {
    return this.agent.agent_session
  }

  private async refresh(): Promise<HerdrAgentInfo> {
    const result = await this.client.call('agent.get', { target: agentTarget(this.agent) })
    const agent = resultObject<HerdrAgentInfo>(result, 'agent')
    if (agent.workspace_id !== this.workspaceId) throw new Error('Herdr agent moved outside its Tandem workspace')
    this.agent = agent
    return agent
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.assertOwned()
      await this.refresh()
      return true
    } catch {
      return false
    }
  }

  async isCurrentlyWorking(): Promise<boolean> {
    const status = (await this.refresh()).agent_status
    return status === 'working' || status === 'unknown'
  }

  private async readRecent(): Promise<HerdrReadResult> {
    const result = await this.client.call('agent.read', {
      target: agentTarget(this.agent),
      source: 'recent_unwrapped',
      lines: READ_LINES,
      format: 'text',
      strip_ansi: true,
    })
    return resultObject<HerdrReadResult>(result, 'read')
  }

  /** The live viewport, not scrollback — see captureSettledOutput for why
   *  `blocked` uses this instead of readRecent. */
  private async readVisible(): Promise<HerdrReadResult> {
    const result = await this.client.call('agent.read', {
      target: agentTarget(this.agent),
      source: 'visible',
      format: 'text',
      strip_ansi: true,
    })
    return resultObject<HerdrReadResult>(result, 'read')
  }

  /** Record newly-observed output under a fresh cursor. Returns whether any
   *  of it was actually new (see newLinesAfterWindow). */
  private async emit(text: string): Promise<boolean> {
    const window = splitLines(text).slice(-MAX_TRACKED_LINES)
    const delta = newLinesAfterWindow(this.lastWindow, window)
    this.lastWindow = window
    // Blank-only churn (the TUI reflowing its own padding) is not output.
    if (!delta.length || delta.every((line) => line === '')) return false
    this.cursorValue += 1
    this.emitted.push({ cursor: this.cursorValue, text: delta.join('\n') })
    let total = this.emitted.reduce((sum, chunk) => sum + chunk.text.length + 1, 0)
    while (this.emitted.length > 1 && total > MAX_REPLAY_CHARS) {
      total -= this.emitted[0].text.length + 1
      this.emitted.shift()
    }
    await this.persist()
    return true
  }

  /** Durably record the cursor before the caller is told about it, so a crash
   *  between "reported" and "persisted" cannot hand the next process a lower
   *  cursor. A store that fails is not fatal: the session keeps working with
   *  process-local state, which is exactly the pre-store behavior. */
  private async persist(): Promise<void> {
    await this.store.save(this.stateKey, {
      cursor: this.cursorValue,
      window: this.lastWindow,
      chunks: this.emitted,
      identity: identityOf(this.workspaceId, this.agent),
    }).catch(() => {})
  }

  /**
   * Everything emitted after `cursor`. A cursor AHEAD of this session's own
   * (a caller holding a cursor from before a bridge restart re-adopted this
   * session, whose in-memory history starts empty) is treated as unknown
   * history and served everything retained, because the alternative is
   * answering a live session with permanent silence.
   */
  private replaySince(cursor: number): string {
    const from = cursor > this.cursorValue ? 0 : cursor
    return this.emitted.filter((chunk) => chunk.cursor > from).map((chunk) => chunk.text).join('\n')
  }

  /**
   * A cursor from a caller must never come back smaller than it went in. The
   * durable store normally makes that automatic, but when it could not be
   * trusted (corrupt, foreign, swept) this session's counter would restart
   * below the caller's. Adopting the caller's value keeps the sequence
   * monotonic from the only perspective that matters — theirs — and the
   * replay above has already treated the unknown range as "serve everything
   * retained" rather than silence.
   */
  private adoptCallerCursor(cursor: number): void {
    if (Number.isSafeInteger(cursor) && cursor > this.cursorValue) this.cursorValue = cursor
  }

  /**
   * Read the transcript for a SETTLED agent and emit whatever is new.
   * Returns whether anything new was emitted.
   *
   * Terminal/settled STATUS and scrollback READABILITY are two different
   * things:
   *   - idle/done: the turn is over and recent_unwrapped scrollback is the
   *     right transcript to report.
   *   - blocked: settled (a human decision is needed), but NOT reliably
   *     scrollback-readable — recent_unwrapped can fail against a blocked
   *     alternate-screen agent (live-reproduced). `visible` (the live
   *     viewport, which is exactly what a blocked prompt needs) is used
   *     instead.
   *   - working/unknown: never read at all. A read taken mid-turn races
   *     Herdr's buffer and can later duplicate or drop output relative to a
   *     settled read, since the two reads aren't causally ordered the way two
   *     settled reads are. Callers get what has already been emitted and must
   *     poll again until settled.
   *
   * READ CHURN: a settled agent that has not changed lifecycle state since
   * the last read has nothing to add, so the read is skipped entirely — an
   * idle session polled every second costs one cheap `agent.get`, not a
   * 160-line `agent.read` per poll. A turn in flight always reads, because
   * "settled with no state change" is also how a turn Herdr collapsed into a
   * single transition looks, and losing that output is the worse failure.
   */
  private async captureSettledOutput(status: HerdrAgentStatus): Promise<boolean> {
    if (!isSettled(status)) return false
    const seq = this.agent.state_change_seq
    const unchanged = seq !== undefined && this.lastReadSeq === seq
    if (unchanged && !this.pendingTurn) return false
    const read = status === 'blocked' ? await this.readVisible() : await this.readRecent()
    this.lastReadSeq = seq
    const blocked = status === 'blocked' ? '\n\n[Herdr: agent is blocked and needs human input.]' : ''
    return await this.emit(`${read.text}${blocked}`)
  }

  /**
   * Whether a settled status means THIS session's caller is done waiting.
   *
   * Herdr's `idle`/`done` are the same underlying settled state, and both
   * survive from the PREVIOUS turn: right after a prompt is submitted, and
   * before Herdr's detection loop has observed the agent start working, a
   * status read reports the old settled state. Believing it ends the poll
   * loop one turn early and reports the previous turn's transcript as this
   * turn's answer — the repeat-turn failure. `state_change_seq` moving past
   * the value observed at submission is the proof that the reported settled
   * state belongs to the new turn; newly-observed output is accepted as
   * equivalent proof, for the case where Herdr collapses a whole turn into a
   * single observed transition — but only when there was already a baseline
   * window to diff against, since on a session that has never been read (a
   * fresh spawn, a just-adopted session) the FIRST read reports the
   * pre-existing screen as new, which proves nothing about this turn.
   */
  private turnSettled(status: HerdrAgentStatus, capturedNewOutput: boolean): boolean {
    if (!isSettled(status)) return false
    const pending = this.pendingTurn
    if (!pending) return true
    const seq = this.agent.state_change_seq
    if (pending.submittedSeq === undefined || seq === undefined) return true
    return seq > pending.submittedSeq || (capturedNewOutput && pending.hadBaseline)
  }

  async send(text: string): Promise<{ report: string; cursor: number; status: 'done' | 'running' }> {
    const before = await this.refresh()
    if (before.agent_status === 'blocked') throw new Error('Herdr agent is blocked and needs human input')
    if (before.agent_status === 'working' || before.agent_status === 'unknown') {
      throw new Error(`Herdr agent is ${before.agent_status}; wait before sending another instruction`)
    }
    // One ATOMIC agent.prompt call with an inline `wait`: Herdr documents
    // this as the race-free primitive — submission and the wait for a
    // settled state start together, so there is no window where a separate
    // wait call can match the STALE pre-submission status. Live-confirmed
    // this matters: a standalone agent.wait issued right after a separate,
    // un-waited agent.prompt returned `ok` in ~4ms, matching the agent's
    // still-"idle" pre-submission status before Herdr's own detection loop
    // had observed the transition to "working" — the turn's real output was
    // then silently lost (a blank report reported as "done").
    const turnStartCursor = this.cursorValue
    this.pendingTurn = { submittedSeq: before.state_change_seq, hadBaseline: this.lastWindow.length > 0 }
    let prompted: Record<string, unknown> | undefined
    try {
      prompted = await this.client.call('agent.prompt', {
        target: agentTarget(this.agent),
        text,
        wait: {
          until: ['idle', 'done', 'blocked'],
          timeout_ms: SEND_SOFT_CAP_MS,
        },
      }, SEND_SOFT_CAP_MS + 5_000)
    } catch (error) {
      if (!(error instanceof HerdrApiError) || !['timeout', 'agent_prompt_stalled'].includes(error.code)) throw error
      // The prompt was already submitted by this same atomic call — NEVER
      // resend. Just refresh semantic status (cheap agent.get, never a
      // transcript read) and report from there.
      await this.refresh()
    }
    if (prompted) this.agent = resultObject<HerdrAgentInfo>(prompted, 'agent')
    const status = this.agent.agent_status
    const captured = await this.captureSettledOutput(status)
    if (!this.turnSettled(status, captured)) {
      // Still working/unknown at the soft cap — or settled only in the stale,
      // pre-transition sense. Report nothing new rather than a mid-write
      // snapshot or the previous turn's transcript; the caller polls
      // readSince() with this cursor until the turn genuinely settles.
      return { report: '', cursor: this.cursorValue, status: 'running' }
    }
    this.pendingTurn = undefined
    return {
      report: this.replaySince(turnStartCursor),
      cursor: this.cursorValue,
      status: 'done',
    }
  }

  async readSince(cursor: number): Promise<{ text: string; cursor: number; idle: boolean }> {
    const agent = await this.refresh()
    const status = agent.agent_status
    const captured = await this.captureSettledOutput(status)
    const settled = this.turnSettled(status, captured)
    if (settled) this.pendingTurn = undefined
    const text = this.replaySince(cursor)
    this.adoptCallerCursor(cursor)
    return {
      text,
      cursor: this.cursorValue,
      idle: settled,
    }
  }

  async applyControls(controls: { model?: string; effort?: string }): Promise<string[]> {
    if (this.engine !== 'claude' && (controls.model || controls.effort)) {
      throw new Error('model/effort are Claude-only options')
    }
    const applied: string[] = []
    for (const [key, value] of [['model', controls.model], ['effort', controls.effort]] as const) {
      if (!value) continue
      const prompted = await this.client.call('agent.prompt', {
        target: agentTarget(this.agent),
        text: `/${key} ${value}`,
        wait: { until: ['idle', 'done', 'blocked'], timeout_ms: SEND_SOFT_CAP_MS },
      }, SEND_SOFT_CAP_MS + 5_000)
      this.agent = resultObject<HerdrAgentInfo>(prompted, 'agent')
      if (this.agent.agent_status === 'blocked') throw new Error(`Herdr agent blocked while applying ${key}`)
      applied.push(key)
    }
    return applied
  }

  async interrupt(): Promise<void> {
    await this.assertOwned()
    await this.client.call('agent.send_keys', { target: agentTarget(this.agent), keys: ['ctrl+c'] })
    // The turn this cancels will never produce its own settled transition, so
    // stop holding poll loops open waiting for one. Whatever it printed before
    // the interrupt is still delivered by the next settled read.
    this.pendingTurn = undefined
  }

  private async assertOwned(): Promise<void> {
    const owner = await this.ownerIdProvider()
    const result = await this.client.call('workspace.get', { workspace_id: this.workspaceId })
    const workspace = resultObject<HerdrWorkspaceInfo>(result, 'workspace')
    const tokens = workspace.tokens ?? {}
    if (
      tokens[OWNER_TOKEN] !== owner ||
      tokens[NAME_TOKEN] !== this.name ||
      tokens[ENGINE_TOKEN] !== this.engine
    ) {
      throw new Error('refusing to control a Herdr workspace without matching Tandem ownership')
    }
  }

  async close(): Promise<void> {
    await this.assertOwned()
    await this.client.call('workspace.close', { workspace_id: this.workspaceId })
    // The agent is gone for good: its transcript state must not outlive it on
    // disk, both to bound retention and because it is terminal output.
    await this.store.clear(this.stateKey).catch(() => {})
  }
}
