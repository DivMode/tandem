/** Selects the concrete lifecycle used for interactive terminal engines. */
import type { EngineId } from './drivable.ts'
import { CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR, SHELL_DESCRIPTOR } from './drivable.ts'
import type { TerminalSessionLike } from './engines/terminal-adapter.ts'
import {
  HerdrTerminalSession,
  SocketHerdrApiClient,
  listOwnedHerdrSessions,
  type HerdrApiClient,
  type HerdrEngineId,
} from './herdr-terminal-session.ts'
import { makeOwnerIdProvider, type OwnerIdProvider } from './ownership.ts'
import { TerminalSession } from './terminal-session.ts'

export type TerminalEngineId = Extract<EngineId, 'claude' | 'codex' | 'shell'>
export type TerminalBackendKind = 'tmux' | 'herdr'

export interface TerminalBackendSpawnOptions {
  name: string
  engine: TerminalEngineId
  cwd: string
  allowlist: string[]
  model?: string
  effort?: string
}

export interface OwnedTerminalSession {
  name: string
  engine: TerminalEngineId
  cwd: string
  updatedAt: number
  attachHint: string
}

export interface TerminalBackend {
  readonly kind: TerminalBackendKind
  spawn(opts: TerminalBackendSpawnOptions): Promise<TerminalSessionLike>
  attachExisting(name: string, engine: TerminalEngineId, allowlist: string[]): Promise<TerminalSessionLike | undefined>
  exists(name: string): Promise<boolean>
  engineTagOf(name: string): Promise<TerminalEngineId | undefined>
  listOwned?(): Promise<OwnedTerminalSession[]>
}

class TmuxTerminalBackend implements TerminalBackend {
  readonly kind = 'tmux' as const

  spawn(opts: TerminalBackendSpawnOptions): Promise<TerminalSessionLike> {
    const descriptor = opts.engine === 'claude'
      ? CLAUDE_DESCRIPTOR
      : opts.engine === 'codex'
        ? CODEX_DESCRIPTOR
        : SHELL_DESCRIPTOR
    return TerminalSession.spawn({
      name: opts.name,
      cwd: opts.cwd,
      allowlist: opts.allowlist,
      model: opts.model,
      effort: opts.effort,
      descriptor,
    })
  }

  attachExisting(name: string, engine: TerminalEngineId, allowlist: string[]): Promise<TerminalSessionLike | undefined> {
    const descriptor = engine === 'claude'
      ? CLAUDE_DESCRIPTOR
      : engine === 'codex'
        ? CODEX_DESCRIPTOR
        : SHELL_DESCRIPTOR
    return TerminalSession.attachExisting(name, allowlist, descriptor)
  }

  exists(name: string): Promise<boolean> {
    return TerminalSession.exists(name)
  }

  async engineTagOf(name: string): Promise<TerminalEngineId | undefined> {
    const tag = await TerminalSession.engineTagOf(name)
    return tag === 'claude' || tag === 'codex' || tag === 'shell' ? tag : undefined
  }
}

export class HerdrTerminalBackend implements TerminalBackend {
  readonly kind = 'herdr' as const
  private readonly client: HerdrApiClient
  private readonly ownerIdProvider: OwnerIdProvider

  constructor(
    client: HerdrApiClient = new SocketHerdrApiClient(),
    ownerIdProvider: OwnerIdProvider = makeOwnerIdProvider(),
  ) {
    this.client = client
    this.ownerIdProvider = ownerIdProvider
  }

  spawn(opts: TerminalBackendSpawnOptions): Promise<TerminalSessionLike> {
    if (opts.engine === 'shell') throw new Error('Herdr backend supports Claude and Codex, not shell')
    return HerdrTerminalSession.spawn({
      ...opts,
      engine: opts.engine,
      ownerIdProvider: this.ownerIdProvider,
    }, this.client)
  }

  attachExisting(
    name: string,
    engine: TerminalEngineId,
    allowlist: string[],
  ): Promise<TerminalSessionLike | undefined> {
    if (engine === 'shell') return Promise.resolve(undefined)
    return HerdrTerminalSession.attachExisting(
      name,
      engine as HerdrEngineId,
      allowlist,
      this.client,
      this.ownerIdProvider,
    )
  }

  exists(name: string): Promise<boolean> {
    return HerdrTerminalSession.exists(name, this.client, this.ownerIdProvider)
  }

  engineTagOf(name: string): Promise<HerdrEngineId | undefined> {
    return HerdrTerminalSession.engineTagOf(name, this.client, this.ownerIdProvider)
  }

  async listOwned(): Promise<OwnedTerminalSession[]> {
    return (await listOwnedHerdrSessions(this.client, this.ownerIdProvider)).map((session) => ({
      name: session.name,
      engine: session.engine,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      attachHint: new HerdrTerminalSessionFactoryHint(session.agent.name || session.agent.pane_id).toString(),
    }))
  }
}

/** Keeps the listing attach hint native without exposing mutable session internals. */
class HerdrTerminalSessionFactoryHint {
  private readonly target: string

  constructor(target: string) {
    this.target = target
  }

  toString(): string {
    const binary = process.env.TANDEM_HERDR_BIN?.trim() || 'herdr'
    const session = process.env.TANDEM_HERDR_SESSION?.trim() || 'default'
    return `${session === 'default' ? binary : `${binary} --session ${session}`} agent attach ${this.target}`
  }
}

export function selectedTerminalBackendKind(value = process.env.TANDEM_TERMINAL_BACKEND): TerminalBackendKind {
  const normalized = value?.trim().toLowerCase() || 'tmux'
  if (normalized !== 'tmux' && normalized !== 'herdr') {
    throw new Error('TANDEM_TERMINAL_BACKEND must be "tmux" or "herdr"')
  }
  return normalized
}

export function createTerminalBackend(kind = selectedTerminalBackendKind()): TerminalBackend {
  return kind === 'herdr' ? new HerdrTerminalBackend() : new TmuxTerminalBackend()
}

/** Entrypoints load protected config before importing the router, so this is stable for the process lifetime. */
export const terminalBackend = createTerminalBackend()
