/**
 * Native Herdr lifecycle for Tandem's interactive Claude and Codex engines.
 *
 * Herdr remains the authoritative runtime: Tandem creates a no-focus workspace,
 * starts an agent in its root pane, reads semantic status/revisions, submits
 * prompts, interrupts with Herdr keys, and closes only its own tagged workspace.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { delimiter as pathDelimiter, isAbsolute } from 'node:path'
import type { EngineId } from './drivable.ts'
import type { TerminalSessionLike } from './engines/terminal-adapter.ts'
import { isCwdAllowed, safeResolve } from './cwd-allowlist.ts'
import { makeOwnerIdProvider, type OwnerIdProvider } from './ownership.ts'

const OWNER_TOKEN = 'tandem_owner'
const NAME_TOKEN = 'tandem_session'
const ENGINE_TOKEN = 'tandem_engine'
const AGENT_TOKEN = 'tandem_agent'
const METADATA_SOURCE = 'tandem'
const MAX_WIRE_BYTES = 16 * 1024 * 1024
const SESSION_NAME_RE = /^[A-Za-z0-9._-]+$/
const HERDR_SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
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

interface HerdrSessionList {
  sessions?: Array<{ name?: string; running?: boolean; socket_path?: string }>
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Herdr command failed: ${stderr.trim() || error.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

/** Resolve the selected persistent Herdr session without changing its state. */
export async function resolveHerdrSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  run: (file: string, args: string[]) => Promise<string> = execFileText,
): Promise<string> {
  const explicit = env.TANDEM_HERDR_SOCKET?.trim()
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('TANDEM_HERDR_SOCKET must be an absolute path')
    return explicit
  }
  const binary = env.TANDEM_HERDR_BIN?.trim() || 'herdr'
  const sessionName = env.TANDEM_HERDR_SESSION?.trim() || 'default'
  if (!HERDR_SESSION_RE.test(sessionName)) throw new Error('TANDEM_HERDR_SESSION is invalid')
  let parsed: HerdrSessionList
  try {
    parsed = JSON.parse(await run(binary, ['session', 'list', '--json'])) as HerdrSessionList
  } catch (error) {
    throw new Error(`could not inspect Herdr sessions: ${error instanceof Error ? error.message : String(error)}`)
  }
  const selected = parsed.sessions?.find((session) => session.name === sessionName)
  if (!selected?.running || !selected.socket_path || !isAbsolute(selected.socket_path)) {
    throw new Error(`Herdr session "${sessionName}" is not running`)
  }
  return selected.socket_path
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
  private readonly socketPath: Promise<string>

  constructor(socketPath: Promise<string> = resolveHerdrSocketPath()) {
    this.socketPath = socketPath
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
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
      const readResult = await client.call('agent.read', {
        target,
        source: 'recent_unwrapped',
        lines: 80,
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
        // trust choice through Herdr's native key API.
        await client.call('agent.send_keys', { target, keys: ['enter'] })
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

  private constructor(
    owned: OwnedHerdrSession,
    client: HerdrApiClient,
    ownerIdProvider: OwnerIdProvider,
  ) {
    this.name = owned.name
    this.engine = owned.engine
    this.cwd = owned.cwd
    this.workspaceId = owned.workspaceId
    this.agent = owned.agent
    this.client = client
    this.ownerIdProvider = ownerIdProvider
    this.ready = Boolean(owned.agent.interactive_ready && !owned.agent.launch_pending)
    this.readinessWarning = this.ready
      ? undefined
      : 'Herdr started the agent but it has not reported interactive readiness yet.'
  }

  static async spawn(
    opts: HerdrSpawnOptions,
    client: HerdrApiClient = new SocketHerdrApiClient(),
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
    const ownerIdProvider = opts.ownerIdProvider ?? makeOwnerIdProvider()
    const owner = await ownerIdProvider()
    const agentName = agentNameFor(opts.name)
    const created = await client.call('workspace.create', {
      cwd,
      focus: false,
      label: `Tandem ${opts.name}`,
      env: herdrWorkspaceEnvironment(),
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
      return new HerdrTerminalSession({
        name: opts.name,
        engine: opts.engine,
        cwd,
        updatedAt: Number(agent.revision) || Date.now(),
        workspaceId: workspace.workspace_id,
        agent,
      }, client, ownerIdProvider)
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
  ): Promise<HerdrTerminalSession | undefined> {
    const owned = (await listOwnedHerdrSessions(client, ownerIdProvider))
      .find((session) => session.name === name && session.engine === engine)
    if (!owned || !isCwdAllowed(owned.cwd, allowlist)) return undefined
    const canonical = safeResolve(owned.cwd)
    if (!isCwdAllowed(canonical, allowlist)) return undefined
    return new HerdrTerminalSession({ ...owned, cwd: canonical }, client, ownerIdProvider)
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
    const binary = process.env.TANDEM_HERDR_BIN?.trim() || 'herdr'
    const session = process.env.TANDEM_HERDR_SESSION?.trim() || 'default'
    const prefix = session === 'default' ? binary : `${binary} --session ${session}`
    return `${prefix} agent attach ${agentTarget(this.agent)}`
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

  private async readRecent(): Promise<{ text: string; revision: number }> {
    const result = await this.client.call('agent.read', {
      target: agentTarget(this.agent),
      source: 'recent_unwrapped',
      lines: 160,
      format: 'text',
      strip_ansi: true,
    })
    return resultObject<HerdrReadResult>(result, 'read')
  }

  async send(text: string): Promise<{ report: string; cursor: number; status: 'done' | 'running' }> {
    const before = await this.refresh()
    if (before.agent_status === 'blocked') throw new Error('Herdr agent is blocked and needs human input')
    if (before.agent_status === 'working' || before.agent_status === 'unknown') {
      throw new Error(`Herdr agent is ${before.agent_status}; wait before sending another instruction`)
    }
    try {
      const prompted = await this.client.call('agent.prompt', {
        target: agentTarget(this.agent),
        text,
        wait: {
          until: ['idle', 'done', 'blocked'],
          timeout_ms: SEND_SOFT_CAP_MS,
        },
      }, SEND_SOFT_CAP_MS + 5_000)
      this.agent = resultObject<HerdrAgentInfo>(prompted, 'agent')
    } catch (error) {
      if (!(error instanceof HerdrApiError) || !['timeout', 'agent_prompt_stalled'].includes(error.code)) throw error
      await this.refresh()
    }
    const read = await this.readRecent()
    const status = this.agent.agent_status
    const blocked = status === 'blocked' ? '\n\n[Herdr: agent is blocked and needs human input.]' : ''
    return {
      report: `${read.text}${blocked}`,
      cursor: read.revision,
      status: isSettled(status) ? 'done' : 'running',
    }
  }

  async readSince(cursor: number): Promise<{ text: string; cursor: number; idle: boolean }> {
    const [agent, read] = await Promise.all([this.refresh(), this.readRecent()])
    const fresh = read.revision > cursor
    const blocked = agent.agent_status === 'blocked' ? '\n\n[Herdr: agent is blocked and needs human input.]' : ''
    return {
      text: fresh ? `${read.text}${blocked}` : '',
      cursor: read.revision,
      idle: isSettled(agent.agent_status),
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
  }
}
