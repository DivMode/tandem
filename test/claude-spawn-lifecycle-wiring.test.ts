/**
 * The spawn side of the trusted completion path: a Tandem-owned Claude worker
 * must actually RECEIVE the operator's settings file and the session stamp.
 *
 * The two pure builders are covered in claude-worker-env.test.ts; what is
 * checked here is the wiring — that the Herdr spawn path calls them, puts the
 * flag on the agent's argv and the stamp in the workspace environment, and that
 * an unconfigured host still spawns exactly what it spawned before.
 *
 * The tmux path builds the same two pieces from the same functions
 * (bridge/terminal-session.ts, `claudeWorkerArgv` / `claudeWorkerEnvironment`),
 * but its spawn cannot be exercised without a live tmux server, so it stays a
 * manual smoke test — as every other tmux spawn assertion in this suite does.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryHerdrCursorStore } from '../bridge/herdr-cursor-store.ts'
import { HerdrTerminalSession, type HerdrAgentInfo, type HerdrApiClient } from '../bridge/herdr-terminal-session.ts'
import { SESSION_ID_ENV } from '../bridge/claude-lifecycle-store.ts'
import { CLAUDE_SETTINGS_PATH_ENV, ClaudeSettingsError, tandemSessionIdFor } from '../bridge/claude-worker-env.ts'

const owner = async () => 'a'.repeat(64)
const cwd = process.cwd()

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env[CLAUDE_SETTINGS_PATH_ENV]
})

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-settings-'))
  roots.push(dir)
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify({ hooks: { Stop: [] } }), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function agent(kind: 'claude' | 'codex' = 'claude'): HerdrAgentInfo {
  return {
    terminal_id: 'w-test:p-1',
    name: 'tandem-deadbeef0000',
    agent: kind,
    agent_status: 'idle',
    workspace_id: 'w-test',
    tab_id: 't-1',
    pane_id: 'p-1',
    interactive_ready: true,
    cwd,
    revision: 1,
    state_change_seq: 100,
  }
}

interface Calls {
  client: HerdrApiClient
  create: Record<string, unknown>[]
  start: Record<string, unknown>[]
}

function recordingClient(kind: 'claude' | 'codex' = 'claude'): Calls {
  const calls: Calls = {
    create: [],
    start: [],
    client: {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          calls.create.push(params)
          return { workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'agent.start') {
          calls.start.push(params)
          return { agent: agent(kind) }
        }
        if (method === 'workspace.report_metadata') return {}
        if (method === 'agent.get') return { agent: agent(kind) }
        if (method === 'agent.read') return { read: { text: '', revision: 0 } }
        if (method === 'workspace.close') return {}
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  return calls
}

function spawn(calls: Calls, name: string, engine: 'claude' | 'codex' = 'claude') {
  return HerdrTerminalSession.spawn(
    { name, engine, cwd, allowlist: [cwd], ownerIdProvider: owner },
    calls.client,
    new MemoryHerdrCursorStore(),
  )
}

describe('a configured settings file reaches the Claude worker', () => {
  it('passes --settings on the agent argv and stamps the session id into its environment', async () => {
    const path = settingsFile()
    process.env[CLAUDE_SETTINGS_PATH_ENV] = path
    const calls = recordingClient()

    await spawn(calls, 'wired')

    expect(calls.start[0]!.args).toEqual(['--settings', path])
    expect(calls.create[0]!.env).toMatchObject({ [SESSION_ID_ENV]: tandemSessionIdFor('wired') })
  })

  it('stamps the SAME id the router derives, or no hook record could ever be matched', async () => {
    process.env[CLAUDE_SETTINGS_PATH_ENV] = settingsFile()
    const calls = recordingClient()

    await spawn(calls, 'matched')

    const env = calls.create[0]!.env as Record<string, string>
    expect(env[SESSION_ID_ENV]).toBe(tandemSessionIdFor('matched'))
  })

  it('keeps model and effort working alongside the settings flag', async () => {
    const path = settingsFile()
    process.env[CLAUDE_SETTINGS_PATH_ENV] = path
    const calls = recordingClient()

    await HerdrTerminalSession.spawn(
      { name: 'flags', engine: 'claude', cwd, allowlist: [cwd], model: 'opus', effort: 'high', ownerIdProvider: owner },
      calls.client,
      new MemoryHerdrCursorStore(),
    )

    expect(calls.start[0]!.args).toEqual(['--settings', path, '--model', 'opus', '--effort', 'high'])
  })

  it('adds nothing to a Codex worker: the hook is Claude-only', async () => {
    process.env[CLAUDE_SETTINGS_PATH_ENV] = settingsFile()
    const calls = recordingClient('codex')

    await spawn(calls, 'codex-worker', 'codex')

    expect(calls.start[0]!.args).toEqual([])
    expect(calls.create[0]!.env).not.toHaveProperty(SESSION_ID_ENV)
  })
})

describe('an unconfigured host spawns exactly what it always did', () => {
  it('adds no flag and no environment stamp', async () => {
    const calls = recordingClient()

    await spawn(calls, 'unconfigured')

    expect(calls.start[0]!.args).toEqual([])
    expect(calls.create[0]!.env).toEqual({})
  })
})

describe('a configured-but-untrustworthy settings path fails loudly', () => {
  it('refuses to spawn, and leaves no workspace behind', async () => {
    process.env[CLAUDE_SETTINGS_PATH_ENV] = '/definitely/not/here/settings.json'
    const calls = recordingClient()

    await expect(spawn(calls, 'broken')).rejects.toThrow(ClaudeSettingsError)
    // Validated before any Herdr state exists, so there is nothing to clean up.
    expect(calls.create).toEqual([])
    expect(calls.start).toEqual([])
  })
})
