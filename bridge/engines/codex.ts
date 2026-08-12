/**
 * engines/codex.ts — the `codex` DrivableSession adapter.
 *
 * A thin binding of the shared TerminalAdapterSession (./terminal-adapter.ts)
 * to CODEX_DESCRIPTOR — same tmux lifecycle as claude/shell, zero duplicated
 * spawn/warmup/idle-detection logic. Codex has no proven footer marker, so its
 * working/idle state is decided ENTIRELY by pane-stability (see
 * terminal-session.ts stepStability + CODEX_DESCRIPTOR.minStableMs).
 *
 * NO SILENT OPTION LOSS (binding — Phase 2 correction C): CodexSpawnOptions
 * deliberately has no `model`/`effort`/`allowBypass` fields — those are
 * Claude-only. If a caller forwards them anyway (e.g. a router bug), the
 * underlying TerminalSession.spawn() rejects them with a clear error rather
 * than silently ignoring them; TerminalAdapterSession.send() does the same for
 * a per-turn model/effort override.
 *
 * Codex is DISABLED by default — see bridge/engine-registry.ts. This module
 * has no knowledge of enablement; that gate lives in the registry/router.
 */
import { CODEX_DESCRIPTOR } from '../drivable.ts'
import { TerminalSession, type SpawnOptions as TerminalSpawnOptions } from '../terminal-session.ts'
import { TerminalAdapterSession, type TerminalSessionLike } from './terminal-adapter.ts'

export interface CodexSpawnOptions {
  name: string
  cwd: string
  allowlist: string[]
}

export class CodexSession extends TerminalAdapterSession {
  constructor(terminal: TerminalSessionLike) {
    super('codex', terminal)
  }

  static async spawn(
    opts: CodexSpawnOptions,
    spawnFn: (opts: TerminalSpawnOptions) => Promise<TerminalSessionLike> = TerminalSession.spawn,
  ): Promise<CodexSession> {
    const terminal = await spawnFn({ ...opts, descriptor: CODEX_DESCRIPTOR })
    return new CodexSession(terminal)
  }

  static async attachExisting(
    name: string,
    allowlist: string[],
    attachFn: (
      name: string,
      allowlist: string[],
    ) => Promise<TerminalSessionLike | undefined> = (n, a) =>
      TerminalSession.attachExisting(n, a, CODEX_DESCRIPTOR),
  ): Promise<CodexSession | undefined> {
    const terminal = await attachFn(name, allowlist)
    return terminal ? new CodexSession(terminal) : undefined
  }

  static async exists(
    name: string,
    existsFn: (name: string) => Promise<boolean> = TerminalSession.exists,
  ): Promise<boolean> {
    return existsFn(name)
  }
}
