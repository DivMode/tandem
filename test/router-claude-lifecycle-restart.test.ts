/**
 * The baseline has to survive the bridge dying.
 *
 * Tandem's whole reason for parking the lifecycle baseline in the DURABLE turn
 * ledger rather than in a process map is this sequence: a turn is sent, the
 * bridge restarts, the session is cold re-adopted through the backend, and a
 * foreman polls it. If the baseline did not survive, the restarted bridge has
 * two equally wrong options — claim nothing (a finished turn nobody notices) or
 * claim the newest record it can see (the PREVIOUS turn's boundary, reported as
 * this one's). It must instead pick up exactly where it left off.
 *
 * `vi.resetModules()` plus a re-import is the restart: a fresh module graph
 * means a fresh registry, a fresh turn ledger instance, and a fresh lifecycle
 * store instance, all reading the same private state directory off disk — which
 * is precisely what a restarted process gets.
 */
import { describe, expect, it, vi } from 'vitest'
import type { TerminalSessionLike } from '../bridge/engines/terminal-adapter.ts'
import type { TerminalBackend } from '../bridge/terminal-backend.ts'

/** Working forever, on both sides of the restart. */
function terminalFor(name: string): TerminalSessionLike {
  return {
    name,
    cwd: '/tandem-test/not-a-repo',
    ready: true,
    readinessWarning: undefined,
    attachHint: () => 'fake attach',
    isAlive: async () => true,
    isCurrentlyWorking: async () => true,
    send: async () => ({ report: 'still rendering', cursor: 1, status: 'running' as const }),
    readSince: async () => ({ text: 'still rendering', cursor: 1, idle: false }),
    applyControls: async () => [],
    interrupt: async () => {},
    close: async () => {},
    // Unchanged across the restart: this is what a real backend reports for the
    // SAME incarnation (tmux session id + creation time; Herdr workspace +
    // terminal id), and it is what lets the ledger recognise the entry as ours.
    agentIdentity: async () => `fake:${name}`,
  }
}

const known = new Set<string>()
const backend: TerminalBackend = {
  kind: 'herdr',
  spawn: async () => {
    throw new Error('spawn must not be called by this suite')
  },
  attachExisting: async (name) => (known.has(name) ? terminalFor(name) : undefined),
  exists: async (name) => known.has(name),
  engineTagOf: async (name) => (known.has(name) ? 'claude' : undefined),
}

vi.mock('../bridge/terminal-backend.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bridge/terminal-backend.ts')>()
  return { ...actual, terminalBackend: backend }
})

async function freshBridge() {
  vi.resetModules()
  return {
    routeForTest: (await import('../bridge/router.ts')).routeForTest,
    store: (await import('../bridge/claude-lifecycle-store.ts')).defaultClaudeLifecycleStore(),
    sessionIdFor: (await import('../bridge/claude-worker-env.ts')).tandemSessionIdFor,
    inbox: (await import('../bridge/foreman-inbox.ts')).defaultForemanInbox(),
  }
}

describe('a turn sent before a restart is still resolvable after it', () => {
  it('re-adopts the pending turn and lets a Stop end it exactly once', async () => {
    const name = 'restart-survivor'
    known.add(name)

    // --- bridge process #1: send, then die mid-turn ------------------------
    const before = await freshBridge()
    const sent = await before.routeForTest('POST', `/sessions/${name}/send`, { text: 'long job' })
    expect(sent.body).toMatchObject({ status: 'running' })

    // --- Claude finishes while nothing is listening ------------------------
    // The hook runs in the WORKER's process, which the bridge restart did not
    // touch; it stamps the identity Tandem gave it at spawn. UserPromptSubmit
    // fires first, when the prompt lands, then Stop when the turn ends.
    expect(
      before.store.record({
        kind: 'prompt_submit',
        tandemSession: before.sessionIdFor(name),
        claudeSessionId: 'claude-session-id',
      }),
    ).toBeDefined()
    expect(
      before.store.record({
        kind: 'stop',
        tandemSession: before.sessionIdFor(name),
        claudeSessionId: 'claude-session-id',
        message: 'the job finished while the bridge was down',
      }),
    ).toBeDefined()

    // --- bridge process #2: cold re-adoption, then a poll -------------------
    const after = await freshBridge()
    const res = await after.routeForTest('GET', `/sessions/${name}/read`, {}, 'cursor=0')

    expect(res.body).toMatchObject({
      idle: true,
      live: true,
      turnEnded: 'stop',
      finalMessage: 'the job finished while the bridge was down',
    })

    // Exactly once, across the restart and across repeated polls.
    await after.routeForTest('GET', `/sessions/${name}/read`, {}, 'cursor=0')
    const recorded = after.inbox
      .read({ limit: 500 })
      .events.filter((e) => e.localName === name)
      .map((e) => e.kind)
    expect(recorded).toEqual(['completed'])
  })

  it('does not let the PREVIOUS turn boundary end a turn sent after the restart', async () => {
    const name = 'restart-old-record'
    known.add(name)

    const before = await freshBridge()
    await before.routeForTest('POST', `/sessions/${name}/send`, { text: 'first job' })
    before.store.record({
      kind: 'prompt_submit',
      tandemSession: before.sessionIdFor(name),
      claudeSessionId: 'claude-session-id',
    })
    before.store.record({
      kind: 'stop',
      tandemSession: before.sessionIdFor(name),
      claudeSessionId: 'claude-session-id',
      message: 'the first turn',
    })
    // The first turn is resolved before the restart.
    await before.routeForTest('GET', `/sessions/${name}/read`, {}, 'cursor=0')

    const after = await freshBridge()
    await after.routeForTest('POST', `/sessions/${name}/send`, { text: 'second job' })
    const res = await after.routeForTest('GET', `/sessions/${name}/read`, {}, 'cursor=0')

    // The record is still retained, but it is behind the new turn's baseline.
    expect(res.body).not.toHaveProperty('turnEnded')
    expect(res.body).toMatchObject({ idle: false })
    const recorded = after.inbox
      .read({ limit: 500 })
      .events.filter((e) => e.localName === name)
      .map((e) => e.kind)
    expect(recorded).toEqual(['completed'])
  })
})
