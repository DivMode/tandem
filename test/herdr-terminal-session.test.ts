import { describe, expect, it } from 'vitest'
import { MemoryHerdrCursorStore } from '../bridge/herdr-cursor-store.ts'
import {
  HerdrApiError,
  HerdrTerminalSession,
  herdrWorkspaceEnvironment,
  listOwnedHerdrSessions,
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
    }, client, new MemoryHerdrCursorStore())
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

  it('uses Herdr semantic prompt/read state twice on the same native agent, submitting through one atomic agent.prompt+wait call (no standalone agent.wait)', async () => {
    let current = agent()
    let revision = 10
    const promptTargets: string[] = []
    const promptParams: Record<string, unknown>[] = []
    const reads: Record<string, unknown>[] = []
    const calledMethods: string[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        calledMethods.push(method)
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.prompt') {
          // Atomic submit+wait: settles the turn in this one call — no
          // separate agent.wait, so there is no window where a stale
          // pre-submission status could be matched.
          promptTargets.push(String(params.target))
          promptParams.push(params)
          revision += 1
          current = agent({ revision, agent_status: 'idle' })
          return { type: 'agent_prompted', agent: current }
        }
        if (method === 'agent.wait') throw new Error('agent.wait must not be called standalone — use atomic agent.prompt+wait')
        if (method === 'agent.read') {
          reads.push(params)
          return { type: 'pane_read', read: { text: `reply-${revision}`, revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'continuity',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())
    const first = await session.send('first')
    const second = await session.send('follow-up')
    expect(first.status).toBe('done')
    expect(second.cursor).toBeGreaterThan(first.cursor)
    expect(promptTargets).toEqual(['tandem-deadbeef0000', 'tandem-deadbeef0000'])
    // agent.prompt itself carries the wait — atomic, race-free.
    for (const p of promptParams) {
      expect(p.wait).toEqual({ until: ['idle', 'done', 'blocked'], timeout_ms: 25_000 })
    }
    // No standalone agent.wait call anywhere in the sequence.
    expect(calledMethods).not.toContain('agent.wait')
    // Exactly one transcript read per settled send — idle/done uses recent_unwrapped.
    expect(reads).toHaveLength(2)
    for (const read of reads) expect(read.source).toBe('recent_unwrapped')
    expect(session.nativeSessionRef()?.value).toBe('native-session-id')
  })

  it('confirms only Claude folder trust through Herdr keys during startup, reading the blocked trust screen via visible (never scrollback)', async () => {
    let current = agent({ agent_status: 'blocked', interactive_ready: false, launch_pending: true })
    const keys: string[][] = []
    const reads: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.read') {
          reads.push(params)
          return { type: 'pane_read', read: { text: 'Yes, I trust this folder', revision: 1 } }
        }
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
    }, client, new MemoryHerdrCursorStore())
    expect(session.ready).toBe(true)
    expect(keys).toEqual([['enter']])
    expect(reads).toHaveLength(1)
    expect(reads[0].source).toBe('visible')
    expect(reads[0].source).not.toBe('recent_unwrapped')
  })

  it('navigates to "Yes, I trust this folder" when the arrow-cursor menu defaults to "No, exit" (live-confirmed against Claude Code 2.1.251)', async () => {
    let current = agent({ agent_status: 'blocked', interactive_ready: false, launch_pending: true })
    const keys: string[][] = []
    const reads: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.read') {
          reads.push(params)
          return {
            type: 'pane_read',
            read: {
              // Live-captured shape: an EARLIER `❯` from the shell's own prompt
              // used to launch the agent (unrelated to the TUI menu cursor)
              // precedes the real menu further down.
              text: '❯ claude\n\nQuick safety check: is this a project you created or trust?\n❯ No, exit\n  Yes, I trust this folder',
              revision: 1,
            },
          }
        }
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
      name: 'trust-cursor-defaults-no',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())
    expect(session.ready).toBe(true)
    // Must navigate down onto "Yes, I trust this folder" rather than blindly
    // pressing enter on the defaulted "No, exit" line.
    expect(keys).toEqual([['down', 'enter']])
    expect(reads).toHaveLength(1)
    expect(reads[0].source).toBe('visible')
  })

  it('confirms only the exact Codex directory trust screen, reading via visible', async () => {
    let current = agent({ agent: 'codex', agent_status: 'blocked', interactive_ready: false, launch_pending: true })
    const keys: string[][] = []
    const reads: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.read') {
          reads.push(params)
          return {
            type: 'pane_read',
            read: { text: 'Do you trust the contents of this directory?\n1. Yes, continue', revision: 1 },
          }
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
    }, client, new MemoryHerdrCursorStore())
    expect(session.ready).toBe(true)
    expect(keys).toEqual([['enter']])
    expect(reads).toHaveLength(1)
    expect(reads[0].source).toBe('visible')
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
    }, client, new MemoryHerdrCursorStore())).rejects.toThrow(/needs human input/)
  })
})

describe('Herdr send/poll safety while working/unknown', () => {
  it('a long turn: the atomic agent.prompt+wait times out (still "working"), returns running without reading scrollback and without resending, then polling stays safe and settles without duplicate/lost cursor behavior', async () => {
    let current = agent({ agent_status: 'idle', revision: 10 })
    const reads: string[] = []
    const promptCalls: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.prompt') {
          // The atomic call itself times out — the turn is still "working"
          // when the soft cap elapses. The prompt WAS submitted (Herdr
          // accepted it before starting the wait), so this must never be
          // retried.
          promptCalls.push(params)
          current = agent({ agent_status: 'working', revision: 11 })
          throw new HerdrApiError('timeout', 'timed out')
        }
        if (method === 'agent.wait') throw new Error('agent.wait must not be called standalone')
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.read') {
          reads.push(String(params.target))
          return { type: 'pane_read', read: { text: `settled-${current.revision}`, revision: current.revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'long-turn',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())

    const sent = await session.send('do a long thing')
    // The prompt was submitted exactly once — a timeout on the atomic call
    // must never cause a resend.
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0].wait).toEqual({ until: ['idle', 'done', 'blocked'], timeout_ms: 25_000 })
    expect(sent.status).toBe('running')
    // No scrollback read happened while status was still "working".
    expect(reads).toEqual([])

    // Poll while still working/unknown: still safe, still no scrollback read,
    // and idle stays false so a poll loop keeps going.
    const pollWhileWorking = await session.readSince(sent.cursor)
    expect(pollWhileWorking.idle).toBe(false)
    expect(pollWhileWorking.text).toBe('')
    expect(reads).toEqual([])

    // Now the turn settles.
    current = agent({ agent_status: 'idle', revision: 12 })
    const finalPoll = await session.readSince(pollWhileWorking.cursor)
    expect(finalPoll.idle).toBe(true)
    expect(finalPoll.text).toBe('settled-12')
    // The cursor is TANDEM's own emission counter, not Herdr's read.revision:
    // Herdr returns revision 0 on every agent read (live-measured, 0.8.2), so
    // a revision-derived cursor could never advance and this poll would have
    // reported nothing at all.
    expect(finalPoll.cursor).toBe(1)
    // Exactly one scrollback read happened, once settled — no duplicate reads
    // taken mid-turn that could have produced overlapping/missed output.
    expect(reads).toHaveLength(1)
    // The settled cursor is strictly greater than the pre-settle cursor, so a
    // caller polling again never re-fetches output it already has (no
    // duplicate) and never skips output it hasn't seen (no loss).
    expect(finalPoll.cursor).toBeGreaterThan(pollWhileWorking.cursor)
    // Still exactly one agent.prompt call across the whole test — no retry.
    expect(promptCalls).toHaveLength(1)
  })

  it('atomic agent.prompt+wait times out but the turn had already settled to "blocked" (e.g. a mid-turn permission prompt): reads via visible, reports the blocked notice, never retries the prompt', async () => {
    let current = agent({ agent_status: 'idle', revision: 20 })
    const reads: Record<string, unknown>[] = []
    const promptCalls: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.prompt') {
          promptCalls.push(params)
          // The atomic wait times out from Herdr's own socket-request
          // perspective, but the agent has ACTUALLY already settled into
          // "blocked" by the time we refresh.
          current = agent({ agent_status: 'blocked', revision: 21 })
          throw new HerdrApiError('timeout', 'timed out')
        }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.read') {
          reads.push(params)
          return { type: 'pane_read', read: { text: 'Allow this command? (y/n)', revision: current.revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'timeout-then-blocked',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())

    const sent = await session.send('run something risky')
    expect(promptCalls).toHaveLength(1)
    expect(reads).toHaveLength(1)
    expect(reads[0].source).toBe('visible')
    expect(sent.status).toBe('done')
    expect(sent.report).toContain('Allow this command?')
    expect(sent.report).toContain('[Herdr: agent is blocked and needs human input.]')
    expect(sent.cursor).toBe(1)
  })

  it('atomic agent.prompt+wait times out but the turn had already settled to "idle"/"done": one recent_unwrapped read safely retrieves the final output, never retries the prompt', async () => {
    let current = agent({ agent_status: 'idle', revision: 30 })
    const reads: Record<string, unknown>[] = []
    const promptCalls: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.prompt') {
          promptCalls.push(params)
          // Herdr's own request-level timeout fires, but the turn had
          // ALREADY genuinely finished (idle) by the time we refresh —
          // Herdr's `agent_prompt_stalled` code covers exactly this class
          // of "already-settled-by-the-time-we-check" case too.
          current = agent({ agent_status: 'idle', revision: 31 })
          throw new HerdrApiError('agent_prompt_stalled', 'stalled')
        }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.read') {
          reads.push(params)
          return { type: 'pane_read', read: { text: `LIVE_HERDR_TANDEM_OK`, revision: current.revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'stalled-then-idle',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())

    const sent = await session.send('reply with a marker')
    expect(promptCalls).toHaveLength(1)
    expect(reads).toHaveLength(1)
    expect(reads[0].source).toBe('recent_unwrapped')
    expect(sent.status).toBe('done')
    expect(sent.report).toContain('LIVE_HERDR_TANDEM_OK')
    expect(sent.cursor).toBe(1)
  })

  it('never calls agent.read while agent_status is unknown', async () => {
    let current = agent({ agent_status: 'idle', revision: 5 })
    const reads: string[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.read') {
          reads.push(String(params.target))
          return { type: 'pane_read', read: { text: 'x', revision: current.revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'unknown-status',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())

    current = agent({ agent_status: 'unknown', revision: 6 })
    const page = await session.readSince(0)
    expect(page.idle).toBe(false)
    expect(reads).toEqual([])
  })

  it('a fast turn that settles within the atomic wait (no separate observed-transition step needed) reads the real output — regression for the standalone-agent.wait bug where a fast/immediate settle silently lost the marker', async () => {
    let current = agent({ agent_status: 'idle', revision: 50 })
    const promptCalls: Record<string, unknown>[] = []
    const calledMethods: string[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        calledMethods.push(method)
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.prompt') {
          promptCalls.push(params)
          // Settles WITHIN the same atomic call, immediately — e.g. a very
          // fast no-tool reply. There is no separate agent.wait call for a
          // race to slip through, unlike the old split design.
          current = agent({ agent_status: 'idle', revision: 51 })
          return { type: 'agent_prompted', agent: current }
        }
        if (method === 'agent.read') {
          return { type: 'pane_read', read: { text: 'LIVE_HERDR_TANDEM_OK', revision: current.revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'fast-atomic-settle',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())

    const sent = await session.send('reply with a marker, no tools')
    expect(promptCalls).toHaveLength(1)
    expect(calledMethods).not.toContain('agent.wait')
    expect(sent.status).toBe('done')
    expect(sent.report).toContain('LIVE_HERDR_TANDEM_OK')
    expect(sent.cursor).toBe(1)
  })
})

describe('Herdr blocked-status reads use visible, never scrollback', () => {
  it('a turn that settles into "blocked" (runtime, not startup) via the atomic agent.prompt+wait is read via visible and reports the blocked notice', async () => {
    let current = agent({ agent_status: 'idle', revision: 20 })
    const reads: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: current }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.prompt') {
          // The atomic call itself settles the turn into "blocked" (e.g. a
          // permission prompt) — reproduces the live case where
          // recent_unwrapped failed against a blocked alternate-screen agent.
          current = agent({ agent_status: 'blocked', revision: 22 })
          return { type: 'agent_prompted', agent: current }
        }
        if (method === 'agent.wait') throw new Error('agent.wait must not be called standalone')
        if (method === 'agent.read') {
          reads.push(params)
          return { type: 'pane_read', read: { text: 'Allow this command? (y/n)', revision: current.revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'runtime-blocked',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())

    const sent = await session.send('run something risky')
    expect(reads).toHaveLength(1)
    expect(reads[0].source).toBe('visible')
    expect(reads[0].source).not.toBe('recent_unwrapped')
    expect(sent.report).toContain('Allow this command?')
    expect(sent.report).toContain('[Herdr: agent is blocked and needs human input.]')
    expect(sent.cursor).toBe(1)
  })

  it('readSince() while blocked at runtime also reads via visible, never recent_unwrapped, and reports idle:true', async () => {
    let current = agent({ agent_status: 'blocked', revision: 30 })
    const reads: Record<string, unknown>[] = []
    const client: HerdrApiClient = {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { type: 'workspace_created', workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return { type: 'ok' }
        if (method === 'agent.start') return { type: 'agent_started', agent: agent({ agent_status: 'idle', revision: 29 }) }
        if (method === 'agent.get') return { type: 'agent_info', agent: current }
        if (method === 'agent.read') {
          reads.push(params)
          return { type: 'pane_read', read: { text: 'Allow this command? (y/n)', revision: current.revision } }
        }
        throw new Error(`unexpected ${method}`)
      },
    }
    const session = await HerdrTerminalSession.spawn({
      name: 'runtime-blocked-poll',
      engine: 'claude',
      cwd,
      allowlist: [cwd],
      ownerIdProvider: owner,
    }, client, new MemoryHerdrCursorStore())

    const page = await session.readSince(29)
    expect(reads).toHaveLength(1)
    expect(reads[0].source).toBe('visible')
    expect(page.idle).toBe(true)
    expect(page.text).toContain('Allow this command?')
    expect(page.text).toContain('[Herdr: agent is blocked and needs human input.]')
    // A cursor from BEFORE this session object existed (29) is ahead of its
    // own counter, so the caller is served what the session has rather than
    // silence (replaySince), and the cursor it gets back is never SMALLER
    // than the one it sent (adoptCallerCursor) — a bridge restart must not
    // rewind a caller's cursor.
    expect(page.cursor).toBe(29)
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
