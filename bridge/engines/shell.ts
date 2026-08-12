/**
 * engines/shell.ts — the `shell` DrivableSession adapter.
 *
 * A thin binding of the shared TerminalAdapterSession (./terminal-adapter.ts)
 * to SHELL_DESCRIPTOR (no executable — spawns the pane's default login shell).
 * Same tmux lifecycle as claude/codex, zero duplicated spawn/warmup/idle logic.
 *
 * HONEST SECURITY LANGUAGE (binding — Phase 2 correction F): shell is
 * ARBITRARY OS-USER COMMAND EXECUTION, beginning in an allowlisted cwd. The
 * cwd allowlist is a start-directory/admission boundary, NOT an OS sandbox —
 * once a shell command runs, it has the same reach as any other command that
 * OS user could run (it can `cd` anywhere, read/write anywhere that user can,
 * etc). Enabling `shell` means trusting whoever can call `open_session`/`send`
 * with full command execution as the bridge's OS user. Disabled by default;
 * see bridge/engine-registry.ts.
 *
 * NO SILENT OPTION LOSS (binding — Phase 2 correction C): ShellSpawnOptions has
 * no `model`/`effort`/`allowBypass` fields (Claude-only concepts). Any stray
 * value forwarded anyway is rejected by TerminalSession.spawn()/send() with a
 * clear error, never silently dropped.
 */
import { SHELL_DESCRIPTOR } from '../drivable.ts'
import { TerminalSession, type SpawnOptions as TerminalSpawnOptions } from '../terminal-session.ts'
import { TerminalAdapterSession, type TerminalSessionLike } from './terminal-adapter.ts'

export interface ShellSpawnOptions {
  name: string
  cwd: string
  allowlist: string[]
}

export class ShellSession extends TerminalAdapterSession {
  constructor(terminal: TerminalSessionLike) {
    super('shell', terminal)
  }

  static async spawn(
    opts: ShellSpawnOptions,
    spawnFn: (opts: TerminalSpawnOptions) => Promise<TerminalSessionLike> = TerminalSession.spawn,
  ): Promise<ShellSession> {
    const terminal = await spawnFn({ ...opts, descriptor: SHELL_DESCRIPTOR })
    return new ShellSession(terminal)
  }

  static async attachExisting(
    name: string,
    allowlist: string[],
    attachFn: (
      name: string,
      allowlist: string[],
    ) => Promise<TerminalSessionLike | undefined> = (n, a) =>
      TerminalSession.attachExisting(n, a, SHELL_DESCRIPTOR),
  ): Promise<ShellSession | undefined> {
    const terminal = await attachFn(name, allowlist)
    return terminal ? new ShellSession(terminal) : undefined
  }

  static async exists(
    name: string,
    existsFn: (name: string) => Promise<boolean> = TerminalSession.exists,
  ): Promise<boolean> {
    return existsFn(name)
  }
}
