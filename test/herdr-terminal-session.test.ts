import { describe, expect, it } from 'vitest'
import {
  HerdrTerminalSession,
  herdrWorkspaceEnvironment,
  listOwnedHerdrSessions,
  resolveHerdrSocketPath,
  type HerdrAgentInfo,
  type HerdrApiClient,
} from '../bridge/herdr-terminal-session.ts'

const owner = async () => 'a'.repeat(64)
const cwd = process.cwd()

function agent(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    terminal_id: 'w-test:p-1',
    name: 'tandem-deadbeef0000',
    agent: 'claude',
    agent_status: 'idle',
    agent_session: { source: 'claude', agent: 'claude', kind: 'id', value: 'native-session-id' },
    workspace_id: 'w-test',
    tab_id: 't-1',
    pane_id: 'p-1',
    interactive_ready: true,
    cwd,
    revision: 10,
    ...overrides,
  }
}

describe('Herdr socket selection', () => {
  it('selects one running named session and rejects a stopped one', async () => {
    const run = async () => JSON.stringify({
      sessions: [
        { name: 'default', running: true, socket_path: '/tmp/herdr.sock' },
        { name: 'stopped', running: false, socket_path: '/tmp/stopped.sock' },
      ],
    })
    await expect(resolveHerdrSocketPath({ TANDEM_HERDR_SESSION: 'default' }, run)).resolves.toBe('/tmp/herdr.sock')
    await expect(resolveHerdrSocketPath({ TANDEM_HERDR_SESSION: 'stopped' }, run)).rejects.toThrow(/not running/)
  })
})

describe('Herdr workspace environment', () => {
  it('passes through only an explicitly configured absolute PATH', () => {
    expect(herdrWorkspaceEnvironment({ TANDEM_HERDR_WORKSPACE_PATH: '/opt/bin:/usr/bin' })).toEqual({
      PATH: '/opt/bin:/usr/bin',
    })
    expect(herdrWorkspaceEnvironment({})).toEqual({})
    expect(() => herdrWorkspaceEnvironment({ TANDEM_HERDR_WORKSPACE_PATH: '/opt/bin:relative' })).toThrow(/absolute directories/)
  })
})

describe('HerdrTerminalSession lifecycle', () => {
  it('creates a no-focus workspace, tags it, and starts Claude without permission bypass', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        calls.push({ method, params })
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: agent(), argv: ['claude'] }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'proof',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client)
    expect(session.ready).toBe(true)
    expect(session.nativeSessionRef()?.value).toBe('native-session-id')
    expect(calls[0]).toEqual(expect.objectContaining({
      method: 'workspace.create',
      params: expect.objectContaining({ cwd, focus: false }),
    }))
    expect(calls[1].params).toEqual(expect.objectContaining({
      source: 'tandem',
      tokens: expect.objectContaining({
        tandem_owner: 'a'.repeat(64),
        tandem_session: 'proof',
        tandem_engine: 'claude',
      }),
    }))
    const startArgs = calls[2].params.args as string[]
    expect(calls[2].params.kind).toBe('claude')
    expect(startArgs).not.toContain('--dangerously-skip-permissions')
  })

  it('uses Herdr semantic prompt/read state twice on the same native agent', async () => {
    let current = agent()
    let revision = 10
    const targets: string[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.prompt') {
          targets.push(String(params.target))
          revision += 1
          current = agent({ revision, agent_status: 'idle' })
          return { type: 'agent_prompted', agent: current }
        }
        if (method === 'agent.read') return { type: 'pane_read', read: { text: `reply-${revision}`, revision } }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'continuity',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client)
    const first = await session.send('first')
    const second = await session.send('follow-up')
    expect(first.status).toBe('done')
    expect(second.cursor).toBeGreaterThan(first.cursor)
    expect(targets).toEqual(['tandem-deadbeef0000', 'tandem-deadbeef0000'])
    expect(session.nativeSessionRef()?.value).toBe('native-session-id')
  })

  it('confirms only Claude folder trust through Herdr keys during startup', async () => {
    let current = agent({ agent_status: 'blocked', interactive_ready: false, launch_pending: true })
    const keys: string[][] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.read') return { type: 'pane_read', read: { text: 'Yes, I trust this folder', revision: 1 } }
        if (method === 'agent.send_keys') {
          keys.push(params.keys as string[])
          current = agent()
          return { type: 'ok' }
        }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'trust-once',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client)
    expect(session.ready).toBe(true)
    expect(keys).toEqual([['enter']])
  })

  it('confirms only the exact Codex directory trust screen', async () => {
    let current = agent({ agent: 'codex', agent_status: 'blocked', interactive_ready: false, launch_pending: true })
    const keys: string[][] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.read') return {
          type: 'pane_read',
          read: { text: 'Do you trust the contents of this directory?\n1. Yes, continue', revision: 1 },
        }
        if (method === 'agent.send_keys') {
          keys.push(params.keys as string[])
          current = agent({ agent: 'codex' })
          return { type: 'ok' }
        }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'codex-trust-once',
      engine: 'codex',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client)
    expect(session.ready).toBe(true)
    expect(keys).toEqual([['enter']])
  })

  it('refuses unrelated Codex blocked screens', async () => {
    const blocked = agent({ agent: 'codex', agent_status: 'blocked', interactive_ready: false, launch_pending: true })
    const client: HerdrApiClient = {
      call: async (method) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: blocked }
        if (method === 'agent.read') return { type: 'pane_read', read: { text: 'Allow command?', revision: 1 } }
        throw new Error(`unexpected ${method}`)
      },
    }
    await expect(HerdrTerminalSession.spawn({
      name: 'codex-blocked',
      engine: 'codex',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client)).rejects.toThrow(/needs human input/)
  })
})

describe('Herdr restart inventory', () => {
  it('lists only owner-tagged workspaces and preserves native agent identity', async () => {
    const client: HerdrApiClient = {
      call: async (method) => {
        if (method === 'workspace.list') return {
          type: 'workspace_list',
          workspaces: [
            { workspace_id: 'w-test', tokens: {
              tandem_owner: 'a'.repeat(64),
              tandem_session: 'survivor',
              tandem_engine: 'codex',
              tandem_agent: 'tandem-deadbeef0000',
            } },
            { workspace_id: 'preexisting', tokens: {} },
          ],
        }
        if (method === 'agent.list') return {
          type: 'agent_list',
          agents: [agent({ agent: 'codex', workspace_id: 'w-test' }), agent({ workspace_id: 'preexisting' })],
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const sessions = await listOwnedHerdrSessions(client, owner)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toEqual(expect.objectContaining({ name: 'survivor', engine: 'codex', workspaceId: 'w-test' }))
    expect(sessions[0].agent.agent_session?.value).toBe('native-session-id')
  })
})
