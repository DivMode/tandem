/**
 * The ADDITIVE `recent_events` preview on list_sessions.
 *
 * WHY THE FIELD EXISTS. An MCP client caches a server's tool list for the life
 * of a conversation. A chat that was already open when this server gained
 * `get_foreman_events` can never call it — nothing in the protocol re-reads a
 * schema, and no server can wake a client to make it. That conversation does
 * still call `list_sessions`, which was in the schema it cached, so a field on
 * that response is the only route a completion has back to it.
 *
 * WHAT THESE TESTS PIN DOWN, in the order the risk actually runs:
 *   1. `sessions` did not change. This is a compatibility field on a tool every
 *      client already depends on; if the existing half moves, the fix is worse
 *      than the problem.
 *   2. It stays bounded and stable — at most 5, newest first, ids that do not
 *      move between calls and match what get_foreman_events reports.
 *   3. It leaks nothing. It rides on the one tool a stale conversation still
 *      calls, so the redaction is re-applied at THIS layer rather than trusted
 *      from the write path, and no cwd/attach-hint/transcript field is present.
 *   4. It is a preview, not the feed: no caller checkpoint, no paging, and the
 *      checkpoint it does return means "the newest event shown".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// router.ts's audit() and the event sinks write under the state root; the
// hermetic harness already redirects it, and each test here gets its own.
const roots: string[] = []
let stateDir: string
const previousStateDir = process.env.TANDEM_STATE_DIR

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'tandem-recent-events-'))
  roots.push(stateDir)
  process.env.TANDEM_STATE_DIR = stateDir
})

afterEach(() => {
  for (const id of registered.splice(0)) unregisterLive(id)
  if (previousStateDir === undefined) delete process.env.TANDEM_STATE_DIR
  else process.env.TANDEM_STATE_DIR = previousStateDir
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const { ForemanInbox, defaultForemanInbox, DEFAULT_PREVIEW_EVENTS, FOREMAN_PREVIEW_NOTE } = await import(
  '../bridge/foreman-inbox.ts'
)
const { routeForTest } = await import('../bridge/router.ts')
const { listSessions, registerLive, unregisterLive } = await import('../bridge/sessions.ts')
const { dispatchListSessions } = await import('../bridge/fleet-dispatch.ts')
const { createFleetRegistry } = await import('../bridge/fleet-registry.ts')
const { createFleetScheduler } = await import('../bridge/fleet-scheduler.ts')
type DrivableSession = import('../bridge/drivable.ts').DrivableSession
type FleetRuntime = import('../bridge/fleet-runtime.ts').FleetRuntime
type FleetBroker = import('../bridge/fleet-broker.ts').FleetBroker
type FleetSocket = import('../bridge/fleet-registry.ts').FleetSocket

const registered: string[] = []

function fakeSession(id: string, cwd = '/tmp/fake'): DrivableSession {
  return {
    id,
    engine: 'claude',
    cwd,
    isAlive: async () => true,
    isWorking: async () => false,
    send: async () => ({ status: 'done', report: '', cursor: 0 }),
    read: async () => ({ text: '', cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => `tmux attach -t ccm-${id}`,
  }
}

function live(id: string): void {
  registerLive(fakeSession(id))
  registered.push(id)
}

function record(name: string, turn: number, extra: Record<string, unknown> = {}) {
  return defaultForemanInbox().record({
    kind: 'completed',
    source: 'session',
    localName: name,
    engine: 'claude',
    epoch: 1,
    turn,
    ...extra,
  } as Parameters<InstanceType<typeof ForemanInbox>['record']>[0])
}

/** Compare listings ignoring only `updatedAt`, which is Date.now() for a
 *  registry session and therefore differs between two adjacent calls. */
function expectSameSessions(actual: unknown, expected: unknown): void {
  const strip = (value: unknown) =>
    (value as Array<Record<string, unknown>>).map(({ updatedAt, ...rest }) => rest)
  expect(strip(actual)).toEqual(strip(expected))
  for (const session of actual as Array<Record<string, unknown>>) {
    expect(typeof session.updatedAt).toBe('number')
  }
}

async function listing(): Promise<Record<string, unknown>> {
  const result = await routeForTest('GET', '/sessions')
  expect(result.status).toBe(200)
  return result.body as Record<string, unknown>
}

/* -------------------------------------------------------------------------- */

describe('the existing sessions field is unchanged', () => {
  it('carries exactly what listSessions() returns, with recent_events beside it', async () => {
    live('worker-a')
    record('worker-a', 1)

    const body = await listing()
    const direct = await listSessions({})

    expectSameSessions(body.sessions, direct.sessions)
    expect(Object.keys(body).sort()).toEqual(['recent_events', 'sessions'])
  })

  it('lists sessions identically when the inbox is empty, and previews nothing', async () => {
    live('worker-a')

    const body = await listing()
    expectSameSessions(body.sessions, (await listSessions({})).sessions)

    const preview = body.recent_events as Record<string, unknown>
    expect(preview.events).toEqual([])
    expect(preview.counts).toEqual({ shown: 0, retained: 0 })
    expect(preview.older).toBe(false)
    expect(typeof preview.checkpoint).toBe('string')
  })

  it('still lists sessions when the inbox file is unreadable garbage', async () => {
    live('worker-a')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(stateDir, 'foreman'), { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, 'foreman', 'events.json'), 'not json at all', { mode: 0o600 })

    const body = await listing()
    expectSameSessions(body.sessions, (await listSessions({})).sessions)
    expect((body.recent_events as Record<string, unknown>).events).toEqual([])
  })

  it('accepts limit and project exactly as before, without the preview interfering', async () => {
    live('worker-a')
    live('worker-b')
    record('worker-a', 1)

    const result = await routeForTest('GET', '/sessions', {}, 'limit=1')
    expect(result.status).toBe(200)
    const body = result.body as { sessions: unknown[]; recent_events: { counts: { retained: number } } }
    expect(body.sessions).toHaveLength(1)
    // The limit bounds sessions, never the preview.
    expect(body.recent_events.counts.retained).toBe(1)
  })
})

describe('the preview is bounded and ordered newest first', () => {
  it('returns at most 5 of 12 transitions, newest first, and says older ones exist', async () => {
    live('worker-a')
    for (let turn = 1; turn <= 12; turn += 1) record('worker-a', turn)

    const preview = (await listing()).recent_events as {
      events: Array<{ turn: number; seq: number }>
      older: boolean
      counts: { shown: number; retained: number }
      version: number
      note: string
    }

    expect(DEFAULT_PREVIEW_EVENTS).toBe(5)
    expect(preview.events).toHaveLength(5)
    expect(preview.events.map((e) => e.turn)).toEqual([12, 11, 10, 9, 8])
    expect(preview.events.map((e) => e.seq)).toEqual([12, 11, 10, 9, 8])
    expect(preview.older).toBe(true)
    expect(preview.counts).toEqual({ shown: 5, retained: 12 })
    expect(preview.version).toBe(1)
    expect(preview.note).toBe(FOREMAN_PREVIEW_NOTE)
  })

  it('does not claim older events exist when everything retained is shown', async () => {
    live('worker-a')
    record('worker-a', 1)
    record('worker-a', 2)

    const preview = (await listing()).recent_events as { older: boolean; counts: { shown: number } }
    expect(preview.counts.shown).toBe(2)
    expect(preview.older).toBe(false)
  })
})

describe('event ids are stable, and are the same ids get_foreman_events reports', () => {
  it('returns identical ids across two listings', async () => {
    live('worker-a')
    record('worker-a', 1)
    record('worker-a', 2)

    const first = (await listing()).recent_events as { events: Array<{ id: string }> }
    const second = (await listing()).recent_events as { events: Array<{ id: string }> }
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id))
    expect(new Set(first.events.map((e) => e.id)).size).toBe(2)
  })

  it('agrees with the event feed on id, kind, epoch, turn and session', async () => {
    live('worker-a')
    record('worker-a', 1, { kind: 'blocked', reason: 'needs a decision' })

    const preview = (await listing()).recent_events as { events: Array<Record<string, unknown>> }
    const feed = await routeForTest('GET', '/foreman/events')
    const feedEvents = (feed.body as { events: Array<Record<string, unknown>> }).events

    expect(feedEvents).toHaveLength(1)
    expect(preview.events).toHaveLength(1)
    for (const key of ['id', 'seq', 'kind', 'session', 'localName', 'epoch', 'turn', 'needs_foreman_review']) {
      expect(preview.events[0]![key]).toEqual(feedEvents[0]![key])
    }
  })
})

describe('the preview carries no paths, no secrets, and no transcript', () => {
  it('re-redacts a summary at the preview layer, including one written straight into the store', async () => {
    live('worker-a')
    // Bypass record()'s own sanitiser by writing the store file directly: the
    // preview must not depend on the write path having been the current one.
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(stateDir, 'foreman'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(stateDir, 'foreman', 'events.json'),
      `${JSON.stringify({
        version: 1,
        epoch: 'abc123',
        nextSeq: 2,
        droppedThrough: 0,
        events: [
          {
            v: 1,
            id: 'fe_handwritten',
            seq: 1,
            ts: new Date().toISOString(),
            kind: 'completed',
            source: 'session',
            device: 'local',
            localName: 'worker-a',
            session: 'local:worker-a',
            epoch: 1,
            turn: 1,
            summary:
              'wrote /Users/someone/secret/notes.md for someone@example.com using ghp_AAAAAAAAAAAAAAAAAAAAAAAA at https://internal.example.com/x',
            needs_foreman_review: true,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    )

    const preview = (await listing()).recent_events as { events: Array<{ summary?: string }> }
    const summary = preview.events[0]!.summary ?? ''
    expect(summary).not.toContain('/Users/someone')
    expect(summary).not.toContain('someone@example.com')
    expect(summary).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(summary).not.toContain('https://internal.example.com')
    expect(summary).toContain('<path>')
    expect(summary).toContain('<email>')
    expect(summary).toContain('<token>')
    expect(summary).toContain('<url>')
  })

  it('clamps preview text harder than the stored clamp', async () => {
    live('worker-a')
    record('worker-a', 1, { summary: 'x'.repeat(400) })

    const preview = (await listing()).recent_events as { events: Array<{ summary?: string }> }
    expect((preview.events[0]!.summary ?? '').length).toBeLessThanOrEqual(160)
  })

  it('exposes only the known event keys — no cwd, attach hint, transcript or environment', async () => {
    live('worker-a')
    record('worker-a', 1, { summary: 'done', cursor: 42 })

    const preview = (await listing()).recent_events as { events: Array<Record<string, unknown>> }
    const allowed = new Set([
      'v', 'id', 'seq', 'ts', 'kind', 'source', 'device', 'localName', 'session',
      'engine', 'epoch', 'turn', 'cursor', 'summary', 'reason', 'needs_foreman_review',
    ])
    for (const event of preview.events) {
      for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true)
    }
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain('attachHint')
    expect(serialized).not.toContain('transcript')
    expect(serialized).not.toContain('/tmp/fake')
  })

  it('drops the summary entirely when the host set TANDEM_FOREMAN_EVENT_SUMMARIES=0', async () => {
    live('worker-a')
    process.env.TANDEM_FOREMAN_EVENT_SUMMARIES = '0'
    try {
      record('worker-a', 1, { summary: 'a summary nobody should see' })
    } finally {
      delete process.env.TANDEM_FOREMAN_EVENT_SUMMARIES
    }

    const preview = (await listing()).recent_events as { events: Array<Record<string, unknown>> }
    expect(preview.events[0]).not.toHaveProperty('summary')
  })
})

describe('the preview is a preview, not the checkpointed feed', () => {
  it('takes no cursor input and its checkpoint sits at the newest event shown', async () => {
    live('worker-a')
    for (let turn = 1; turn <= 3; turn += 1) record('worker-a', turn)

    const preview = (await listing()).recent_events as { checkpoint: string }
    const page = new ForemanInbox(join(stateDir, 'foreman')).read({ since: preview.checkpoint })
    expect(page.events).toEqual([])
    expect(page.more).toBe(false)
    expect(page.truncated).toBe(false)
  })

  it('is unaffected by the caller having already read the feed', async () => {
    live('worker-a')
    record('worker-a', 1)

    const feed = await routeForTest('GET', '/foreman/events')
    const checkpoint = (feed.body as { checkpoint: string }).checkpoint
    expect(checkpoint).toBeTruthy()

    // The preview has no idea what any caller has read, and must not change.
    const preview = (await listing()).recent_events as { counts: { shown: number } }
    expect(preview.counts.shown).toBe(1)
  })
})

describe('fleet identity: a preview always names a session the caller can address', () => {
  function fakeSocket(): FleetSocket {
    return { send: () => {}, close: () => {}, bufferedAmount: 0 }
  }

  function scriptedRuntime(body: unknown): FleetRuntime {
    const registry = createFleetRegistry()
    registry.register('device-a', 'studio', ['claude'], fakeSocket())
    return {
      registry,
      broker: { sendRequest: async () => ({ status: 200, body }) } as unknown as FleetBroker,
      scheduler: createFleetScheduler(),
    }
  }

  it("rewrites a remote device's preview onto the hub's routing identity", async () => {
    const runtime = scriptedRuntime({
      sessions: [{ id: 'sess-1', engine: 'claude' }],
      recent_events: {
        version: 1,
        events: [{ id: 'fe_x', kind: 'completed', device: 'whatever-it-claims', localName: 'sess-1', session: 'whatever-it-claims:sess-1' }],
        checkpoint: 'fe1_x',
        older: false,
        counts: { shown: 1, retained: 1 },
        note: 'n',
      },
    })

    const result = await dispatchListSessions(runtime, 'device-a', {})
    const body = result.body as { recent_events: { events: Array<Record<string, unknown>> } }
    expect(body.recent_events.events[0]).toMatchObject({
      device: 'device-a',
      session: 'device-a:sess-1',
      localName: 'sess-1',
    })
  })

  it('names local previews "local:<name>", the same way the event feed does', async () => {
    live('worker-a')
    record('worker-a', 1)
    const runtime: FleetRuntime = {
      registry: createFleetRegistry(),
      broker: { sendRequest: async () => ({ status: 500, body: {} }) } as unknown as FleetBroker,
      scheduler: createFleetScheduler(),
    }

    const result = await dispatchListSessions(runtime, undefined, {})
    const body = result.body as {
      sessions: Array<{ id: string }>
      recent_events: { events: Array<{ session: string; device: string }> }
    }
    // A bare local call keeps bare session ids, exactly as before…
    expect(body.sessions[0]!.id).toBe('worker-a')
    // …while the preview uses the composite name, matching get_foreman_events.
    expect(body.recent_events.events[0]!.session).toBe('local:worker-a')
    expect(body.recent_events.events[0]!.device).toBe('local')
  })

  it('leaves a response with no preview untouched', async () => {
    const runtime = scriptedRuntime({ sessions: [{ id: 'sess-1', engine: 'claude' }] })
    const result = await dispatchListSessions(runtime, 'device-a', {})
    expect(result.body).toEqual({
      sessions: [{ id: 'device-a:sess-1', engine: 'claude', device: 'device-a', localName: 'sess-1' }],
    })
  })
})
