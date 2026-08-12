import { afterEach, describe, expect, it } from 'vitest'
import type { DrivableSession, EngineId } from '../bridge/drivable.ts'
import { listSessions, registerLive, unregisterLive } from '../bridge/sessions.ts'

const registered: string[] = []

function fakeSession(id: string, engine: EngineId, cwd = ''): DrivableSession {
  return {
    id,
    engine,
    cwd,
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => ({ status: 'done', report: '', cursor: 0 }),
    read: async () => ({ text: '', cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => engine === 'hermes' ? `Hermes agent "${id}"` : `tmux attach -t ccm-${id}`,
  }
}

afterEach(() => {
  for (const id of registered.splice(0)) unregisterLive(id)
})

describe('listSessions privacy and admission filters', () => {
  it('includes an explicitly attached live Hermes registry session without discovering gateway history', async () => {
    const session = fakeSession('agent-a', 'hermes')
    registerLive(session)
    registered.push(session.id)
    const result = await listSessions({
      enabledEngines: new Set(['claude', 'hermes']),
      allowlist: ['/allowed'],
      listingDependencies: { tmuxFn: async () => '' },
    })
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: 'agent-a', engine: 'hermes', project: 'hermes', live: true }),
    ])
  })

  it('excludes raw tmux rows for disabled engines, disallowed cwd, bad provenance, and relay internals', async () => {
    const rows = [
      'ccm-good\t100\t/allowed/project',
      'ccm-disabled\t101\t/allowed/project',
      'ccm-outside\t102\t/private/project',
      'ccm-bad-owner\t103\t/allowed/project',
      'ccm-relay-loop-lead\t104\t/allowed/project',
    ].join('\n')
    const provenance: Record<string, { engine: string; owner: string }> = {
      good: { engine: 'claude', owner: 'owner-a' },
      disabled: { engine: 'codex', owner: 'owner-a' },
      outside: { engine: 'claude', owner: 'owner-a' },
      'bad-owner': { engine: 'claude', owner: 'owner-b' },
    }
    const result = await listSessions({
      enabledEngines: new Set(['claude']),
      allowlist: ['/allowed'],
      listingDependencies: {
        ownerIdProvider: async () => 'owner-a',
        tmuxFn: async () => rows,
        provenanceReader: async (name) => provenance[name] ?? { engine: '', owner: '' },
      },
    })
    expect(result.sessions.map((s) => s.id)).toEqual(['good'])
  })

  it('deduplicates a registered tmux session against the restart inventory row', async () => {
    const session = fakeSession('same', 'claude', '/allowed/project')
    registerLive(session)
    registered.push(session.id)
    const result = await listSessions({
      enabledEngines: new Set(['claude']),
      allowlist: ['/allowed'],
      listingDependencies: {
        ownerIdProvider: async () => 'owner-a',
        tmuxFn: async () => 'ccm-same\t100\t/allowed/project',
        provenanceReader: async () => ({ engine: 'claude', owner: 'owner-a' }),
      },
    })
    expect(result.sessions.filter((s) => s.id === 'same')).toHaveLength(1)
  })
})
