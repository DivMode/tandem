/**
 * engines/claude.ts — the `claude` DrivableSession adapter.
 *
 * A thin binding of the shared TerminalAdapterSession (./terminal-adapter.ts)
 * to CLAUDE_DESCRIPTOR. The real `claude` binary and tmux lifecycle live in
 * terminal-session.ts, unchanged; this file adds no new tmux/spawn behavior of
 * its own — Phase 2 extracted the adapter's generic behavior out so
 * codex.ts/shell.ts could reuse it, leaving this file Claude-specific only in
 * its default descriptor/spawn wiring.
 *
 * TESTABILITY (binding — Phase 1 plan review amendment #6): the constructor
 * takes a `TerminalSessionLike`-COMPATIBLE dependency, so contract tests inject
 * a fake and never spawn a real tmux/claude process. Production code uses the
 * static `spawn` / `attachExisting` / `exists` factories, which delegate to the
 * real TerminalSession — a real tmux/Claude run is a separate manual smoke test.
 */
import { CLAUDE_DESCRIPTOR } from '../drivable.ts'
import { TerminalSession, type SpawnOptions } from '../terminal-session.ts'
import { TerminalAdapterSession, type TerminalSessionLike } from './terminal-adapter.ts'

export type { TerminalSessionLike }

export class ClaudeSession extends TerminalAdapterSession {
  constructor(terminal: TerminalSessionLike) {
    super('claude', terminal)
  }

  // ---- production factories (delegate to the real TerminalSession by default,
  // but accept an injected factory so spawn/attach/exists regression tests never
  // require a live tmux/claude process either) -------------------------------

  static async spawn(
    opts: SpawnOptions,
    spawnFn: (opts: SpawnOptions) => Promise<TerminalSessionLike> = TerminalSession.spawn,
  ): Promise<ClaudeSession> {
    const terminal = await spawnFn(opts)
    return new ClaudeSession(terminal)
  }

  static async attachExisting(
    name: string,
    allowlist: string[],
    attachFn: (
      name: string,
      allowlist: string[],
    ) => Promise<TerminalSessionLike | undefined> = (n, a) =>
      TerminalSession.attachExisting(n, a, CLAUDE_DESCRIPTOR),
  ): Promise<ClaudeSession | undefined> {
    const terminal = await attachFn(name, allowlist)
    return terminal ? new ClaudeSession(terminal) : undefined
  }

  static async exists(
    name: string,
    existsFn: (name: string) => Promise<boolean> = TerminalSession.exists,
  ): Promise<boolean> {
    return existsFn(name)
  }
}
