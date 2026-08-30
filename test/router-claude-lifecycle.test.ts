/**
 * The trusted completion path, end to end through the router.
 *
 * WHAT THIS IS FOR. Tandem's completion signal has always been an INFERENCE
 * about a terminal, and its expensive failure is the silent one: a backend that
 * reports `working` forever leaves a finished turn unreported until the foreman
 * gives up on it. Claude's own `Stop` hook is a different kind of signal — the
 * engine stating, from its own process at its own turn boundary, that the turn
 * ended. Every fake here reports `idle: false` on every read, FOREVER, which is
 * exactly the state the terminal-only path could never get out of.
 *
 * Everything is injected: no tmux, no Herdr, no `claude`. The lifecycle store
 * and the turn ledger are the REAL ones, writing into the per-worker private
 * state directory the harness provides (test/setup-hermetic-env.ts), because
 * their durability is half of what is under test.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TerminalSessionLike } from '../bridge/engines/terminal-adapter.ts'
import type { TerminalBackend, TerminalEngineId } from '../bridge/terminal-backend.ts'

interface Fake {
  /** The backend's own view of the turn. `false` models "working forever". */
  idle: boolean
  text: string
  /** send() returning 'running' is what leaves a turn pending for a poll. */
  sendStatus: 'done' | 'running'
  engine: TerminalEngineId
  interrupted: number
}

const fakes = new Map<string, Fake>()

function fake(name: string, engine: TerminalEngineId = 'claude'): Fake {
  const state: Fake = { idle: false, text: 'still rendering', sendStatus: 'running', engine, interrupted: 0 }
  fakes.set(name, state)
  return state
}

function terminalFor(name: string): TerminalSessionLike {
  const state = fakes.get(name)!
  return {
    name,
    // A path that is not a git repository, so the completion handoff's git
    // lookup falls back immediately instead of shelling out into this checkout.
    cwd: '/tandem-test/not-a-repo',
    ready: true,
    readinessWarning: undefined,
    attachHint: () => 'fake attach',
    isAlive: async () => true,
    isCurrentlyWorking: async () => !state.idle,
    send: async () => ({ report: state.text, cursor: 1, status: state.sendStatus }),
    readSince: async () => ({ text: state.text, cursor: 1, idle: state.idle }),
    applyControls: async () => [],
    interrupt: async () => {
      state.interrupted += 1
    },
    close: async () => {},
    // A stable per-incarnation identity, as both real backends supply.
    agentIdentity: async () => `fake:${name}`,
  }
}

const backend: TerminalBackend = {
  kind: 'herdr',
  spawn: async () => {
    throw new Error('spawn must not be called by this suite')
  },
  attachExisting: async (name) => (fakes.has(name) ? terminalFor(name) : undefined),
  exists: async (name) => fakes.has(name),
  engineTagOf: async (name) => fakes.get(name)?.engine,
}

vi.mock('../bridge/terminal-backend.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bridge/terminal-backend.ts')>()
  return { ...actual, terminalBackend: backend }
})

const { routeForTest } = await import('../bridge/router.ts')
const { defaultClaudeLifecycleStore } = await import('../bridge/claude-lifecycle-store.ts')
const { tandemSessionIdFor } = await import('../bridge/claude-worker-env.ts')
const { defaultForemanInbox } = await import('../bridge/foreman-inbox.ts')

/** Deposit the record Claude's own Stop hook would have written. */
function hookReports(name: string, kind: 'stop' | 'stop_failure', message?: string): void {
  const event = defaultClaudeLifecycleStore().record({
    kind,
    tandemSession: tandemSessionIdFor(name),
    claudeSessionId: 'claude-session-id',
    ...(message ? { message } : {}),
  })
  expect(event, 'the lifecycle store must accept the hook record').toBeDefined()
}

/** Deposit the record Claude's own UserPromptSubmit hook would have written —
 *  fires the moment a prompt lands, before the Stop/StopFailure that answers
 *  it. Never carries a message (see claude-lifecycle-store.ts). */
function hookSubmits(name: string): void {
  const event = defaultClaudeLifecycleStore().record({
    kind: 'prompt_submit',
    tandemSession: tandemSessionIdFor(name),
    claudeSessionId: 'claude-session-id',
  })
  expect(event, 'the lifecycle store must accept the hook record').toBeDefined()
}

/** Every foreman transition recorded for one session, oldest first. */
function transitions(name: string): Array<{ kind: string; summary?: string; reason?: string }> {
  return defaultForemanInbox()
    .read({ limit: 500 })
    .events.filter((e) => e.localName === name)
    .map((e) => ({ kind: e.kind, summary: e.summary, reason: e.reason }))
}

/** Unique per test: the turn ledger is durable and shared across this file. */
let counter = 0
function newSession(prefix: string, engine: TerminalEngineId = 'claude'): { name: string; state: Fake } {
  counter += 1
  const name = `${prefix}-${counter}`
  return { name, state: fake(name, engine) }
}

const send = (name: string, text = 'do the thing') => routeForTest('POST', `/sessions/${name}/send`, { text })
const poll = (name: string, cursor = 0) => routeForTest('GET', `/sessions/${name}/read`, {}, `cursor=${cursor}`)

beforeEach(() => {
  fakes.clear()
})

describe('a Stop after the baseline ends a turn the backend says is still working', () => {
  it('terminates the pending turn and returns Claude own final message', async () => {
    const { name } = newSession('stale')
    await send(name)
    hookSubmits(name)
    hookReports(name, 'stop', 'I rebased onto main and all 59 tests pass.')

    const res = await poll(name)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      idle: true,
      live: true,
      turnEnded: 'stop',
      finalMessage: 'I rebased onto main and all 59 tests pass.',
    })
    expect(transitions(name)).toEqual([
      { kind: 'completed', summary: 'I rebased onto main and all 59 tests pass.', reason: undefined },
    ])
  })

  it('reports idle even though the backend never stops saying working', async () => {
    const { name, state } = newSession('stale')
    await send(name)
    hookSubmits(name)
    hookReports(name, 'stop')

    expect(state.idle).toBe(false)
    expect((await poll(name)).body).toMatchObject({ idle: true, turnEnded: 'stop' })
  })

  it('falls back to the pane text when the hook carried no message', async () => {
    const { name, state } = newSession('stale')
    state.text = 'scraped from the pane'
    await send(name)
    hookSubmits(name)
    hookReports(name, 'stop')

    expect((await poll(name)).body).not.toHaveProperty('finalMessage')
    expect(transitions(name)).toEqual([{ kind: 'completed', summary: 'scraped from the pane', reason: undefined }])
  })

  it('works through send poll-mode (empty text), not only the read route', async () => {
    const { name } = newSession('stale')
    await send(name)
    hookSubmits(name)
    hookReports(name, 'stop', 'done via poll mode')

    const res = await routeForTest('POST', `/sessions/${name}/send`, { text: '' })

    expect(res.body).toMatchObject({ turnEnded: 'stop', finalMessage: 'done via poll mode' })
  })
})

describe('repeated polls report the turn exactly once', () => {
  it('three identical polls of one Stop produce one completion', async () => {
    const { name } = newSession('dup')
    await send(name)
    hookSubmits(name)
    hookReports(name, 'stop', 'finished')

    const first = await poll(name)
    const second = await poll(name)
    const third = await poll(name)

    expect(first.body).toMatchObject({ turnEnded: 'stop' })
    // The turn is claimed and gone: later polls make no claim of their own.
    expect(second.body).not.toHaveProperty('turnEnded')
    expect(third.body).not.toHaveProperty('turnEnded')
    expect(transitions(name)).toEqual([{ kind: 'completed', summary: 'finished', reason: undefined }])
  })

  it('a Stop that lands while the backend also reports idle still reports once, with the hook message', async () => {
    const { name, state } = newSession('dup')
    await send(name)
    state.idle = true
    hookSubmits(name)
    hookReports(name, 'stop', 'the hook message, not the pane')

    await poll(name)
    await poll(name)

    expect(transitions(name)).toEqual([
      { kind: 'completed', summary: 'the hook message, not the pane', reason: undefined },
    ])
  })
})

describe('a Stop from before the turn began is not this turn boundary', () => {
  it('ignores a record that was already in the store when send opened the turn', async () => {
    const { name } = newSession('old')
    // The PREVIOUS turn's boundary, still retained in the shared store.
    hookReports(name, 'stop', 'the previous turn')

    await send(name)
    const res = await poll(name)

    expect(res.body).toMatchObject({ idle: false })
    expect(res.body).not.toHaveProperty('turnEnded')
    expect(transitions(name)).toEqual([])
  })

  it('ends the turn only once the NEW boundary arrives', async () => {
    const { name } = newSession('old')
    hookReports(name, 'stop', 'the previous turn')
    await send(name)
    expect((await poll(name)).body).not.toHaveProperty('turnEnded')

    hookSubmits(name)
    hookReports(name, 'stop', 'this turn')

    expect((await poll(name)).body).toMatchObject({ turnEnded: 'stop', finalMessage: 'this turn' })
    expect(transitions(name)).toEqual([{ kind: 'completed', summary: 'this turn', reason: undefined }])
  })
})

describe('StopFailure is a terminal failure that needs review, never a completion', () => {
  it('ends the turn and records an error rather than a completion', async () => {
    const { name } = newSession('fail')
    await send(name)
    hookSubmits(name)
    hookReports(name, 'stop_failure')

    const res = await poll(name)

    expect(res.body).toMatchObject({ idle: true, turnEnded: 'stop_failure' })
    expect(res.body).not.toHaveProperty('finalMessage')
    const recorded = transitions(name)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.kind).toBe('error')
    expect(recorded[0]!.reason).toContain('StopFailure')
  })

  it('is claimed exactly once across repeated polls', async () => {
    const { name } = newSession('fail')
    await send(name)
    hookSubmits(name)
    hookReports(name, 'stop_failure')

    await poll(name)
    await poll(name)

    expect(transitions(name).filter((t) => t.kind === 'error')).toHaveLength(1)
    expect(transitions(name).filter((t) => t.kind === 'completed')).toHaveLength(0)
  })
})

describe('interrupt, close and supersede stay authoritative', () => {
  it('a Stop arriving after an interrupt cannot resurrect the interrupted turn', async () => {
    const { name } = newSession('interrupt')
    await send(name)
    await routeForTest('POST', `/sessions/${name}/interrupt`)

    // Claude's hook fires anyway as the interrupted turn unwinds.
    hookReports(name, 'stop', 'partial work')
    const res = await poll(name)

    expect(res.body).not.toHaveProperty('turnEnded')
    expect(transitions(name).map((t) => t.kind)).toEqual(['interrupted'])
  })

  it('a Stop after a close does not report a completion on the closed session', async () => {
    const { name } = newSession('close')
    await send(name)
    await routeForTest('POST', `/sessions/${name}/close`)

    hookReports(name, 'stop', 'too late')
    await poll(name)

    expect(transitions(name).map((t) => t.kind)).toEqual(['closed'])
  })

  // B1 regression: a second send while a Claude turn is GENUINELY pending
  // (the trusted store has already seen this session's own prompt_submit, so
  // the hook is demonstrably wired up and active) is now REJECTED rather than
  // superseded. Overlapping instructions into a session whose completion
  // Tandem trusts is a caller bug, not a legitimate interrupt — the caller has
  // interrupt_session for that.
  it('a second send while a Claude turn is genuinely pending is rejected, not superseded', async () => {
    const { name } = newSession('supersede')
    await send(name, 'first instruction')
    hookSubmits(name) // the first turn's own submit lands: hook evidence exists, still no Stop

    const rejected = await send(name, 'second instruction')
    expect(rejected.status).toBe(409)
    expect((rejected.body as { error: string }).error).toMatch(/already pending/)

    // The first turn is untouched: no supersede was recorded, and its own
    // (later) Stop still resolves it cleanly.
    expect(transitions(name)).toEqual([])
    hookReports(name, 'stop', 'answering the first')
    const res = await poll(name)

    expect(res.body).toMatchObject({ turnEnded: 'stop', finalMessage: 'answering the first' })
    expect(transitions(name).map((t) => t.kind)).toEqual(['completed'])
  })

  // "Sticky stale-working" half of the same guard: a pending turn whose Stop
  // already landed (with no submit yet for anything after it) must not block
  // a new send forever just because nothing has polled it out yet.
  it('a stale pending turn resolved by its own Stop does not block the next send', async () => {
    const { name, state } = newSession('stale-send')
    await send(name, 'first instruction')
    hookSubmits(name)
    hookReports(name, 'stop', 'finished the first')
    // The backend fake still reports working forever — exactly like every
    // other "stale" fixture in this file — so only the trusted store, not the
    // pane, can tell this next send the first turn is actually over.
    expect(state.idle).toBe(false)

    const second = await send(name, 'second instruction')
    expect(second.status).toBe(200)

    // The stale turn was completed (not silently dropped) before the new one
    // began, and the new turn is free to resolve on its own boundary.
    expect(transitions(name).map((t) => t.kind)).toEqual(['completed'])
    hookSubmits(name)
    hookReports(name, 'stop', 'finished the second')
    expect((await poll(name)).body).toMatchObject({ turnEnded: 'stop', finalMessage: 'finished the second' })
    expect(transitions(name).map((t) => t.kind)).toEqual(['completed', 'completed'])
  })

  // Interrupt → new send, with the OLD turn's late Stop landing AFTER the new
  // baseline but BEFORE the new turn's own prompt_submit. Without the ordered
  // baseline→submit→stop requirement this stray Stop would be mistaken for
  // the new turn's boundary.
  it('interrupt then a new send: an old Stop landing before the new submit does not end the new turn', async () => {
    const { name } = newSession('interrupt-resend')
    await send(name, 'first instruction')
    await routeForTest('POST', `/sessions/${name}/interrupt`)

    await send(name, 'second instruction')
    // The interrupted turn's Stop arrives late, racing in after the new
    // baseline but before the new turn has even reached Claude.
    hookReports(name, 'stop', 'partial work from the first turn')
    expect((await poll(name)).body).not.toHaveProperty('turnEnded')
    expect(transitions(name).map((t) => t.kind)).toEqual(['interrupted'])

    // Now the new turn's own boundary arrives, correctly ordered.
    hookSubmits(name)
    hookReports(name, 'stop', 'answering the second, for real')
    const res = await poll(name)

    expect(res.body).toMatchObject({ turnEnded: 'stop', finalMessage: 'answering the second, for real' })
    expect(transitions(name).map((t) => t.kind)).toEqual(['interrupted', 'completed'])
  })

  // External prompt: something (a human at the TUI, most plausibly) submitted
  // a prompt to this Claude process outside Tandem's own send(). No Tandem
  // turn is pending, so the ledger has nothing to say, but the trusted store
  // shows an unmatched prompt_submit and a send must not interleave with it.
  it('an unmatched external prompt_submit blocks a send until it resolves', async () => {
    const { name } = newSession('external')
    hookSubmits(name) // simulates a human typing directly into the Claude TUI

    const blocked = await send(name, 'do something')
    expect(blocked.status).toBe(409)
    expect((blocked.body as { error: string }).error).toMatch(/external prompt/)

    // Once that external turn's own Stop lands, the session reads as ready
    // again and a Tandem send is allowed.
    hookReports(name, 'stop', 'the human is done')
    const allowed = await send(name, 'now it is Tandem\'s turn')
    expect(allowed.status).toBe(200)
  })
})

describe('with no hook installed, nothing changes', () => {
  it('a Claude session with no lifecycle record behaves exactly as before', async () => {
    const { name, state } = newSession('nohook')
    await send(name)

    // Backend still working, no record anywhere: no claim, no event.
    const working = await poll(name)
    expect(working.body).toMatchObject({ idle: false, live: true })
    expect(working.body).not.toHaveProperty('turnEnded')
    expect(transitions(name)).toEqual([])

    // The terminal-only path is untouched and still reports the completion.
    state.idle = true
    state.text = 'the pane settled'
    expect((await poll(name)).body).not.toHaveProperty('turnEnded')
    expect(transitions(name)).toEqual([{ kind: 'completed', summary: 'the pane settled', reason: undefined }])
  })

  it('never consults the store for a non-Claude engine', async () => {
    const { name, state } = newSession('codex', 'codex')
    await send(name)
    // A record filed under this name's identity: a Codex session has no Claude
    // hook, so this must not be read as its turn boundary.
    hookReports(name, 'stop', 'not codex output')

    expect((await poll(name)).body).not.toHaveProperty('turnEnded')
    expect(transitions(name)).toEqual([])

    state.idle = true
    expect(transitions(name)).toEqual([])
    await poll(name)
    expect(transitions(name)).toEqual([{ kind: 'completed', summary: 'still rendering', reason: undefined }])
  })
})

describe('a store that cannot be trusted degrades to the terminal path', () => {
  it('an unreadable lifecycle store never breaks or blocks a poll', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tandemStatePath } = await import('../bridge/state-dir.ts')

    const { name, state } = newSession('corrupt')
    await send(name)

    // Whatever the hook wrote is now unparseable: the store degrades to empty
    // by design, so there is no boundary to find.
    const directory = tandemStatePath('claude-lifecycle')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'events.json'), 'this is not the store you are looking for\n', { mode: 0o600 })

    const working = await poll(name)
    expect(working.status).toBe(200)
    expect(working.body).not.toHaveProperty('turnEnded')

    // And the pre-existing terminal-driven completion still works.
    state.idle = true
    await poll(name)
    expect(transitions(name).map((t) => t.kind)).toEqual(['completed'])
  })
})
