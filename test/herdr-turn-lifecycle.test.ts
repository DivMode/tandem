/**
 * Repeat turns, cursors, and read churn against the Herdr backend.
 *
 * Three facts about real Herdr (0.8.2, live-measured on the machine this was
 * written against) drive every test here:
 *
 *  1. `agent.read` returns `revision: 0` for an agent pane — on every source
 *     (recent_unwrapped, visible, detection) and on pane.read too. A cursor
 *     derived from it can never advance, so `readSince` could never report a
 *     turn that outlived the send soft cap. Every read below returns revision
 *     0 to keep that honest.
 *  2. A read is a WINDOW over the pane, not a delta: consecutive reads repeat
 *     everything that is still on screen. Reporting the window verbatim makes
 *     a second turn re-deliver the first turn's answer.
 *  3. `idle`/`done` are the same settled state and survive from the previous
 *     turn, so a status read taken before Herdr observes the new turn start
 *     reports the PREVIOUS turn's settled state. `state_change_seq` is what
 *     separates the two.
 */
import { describe, expect, it } from 'vitest'
import { MemoryHerdrCursorStore } from '../bridge/herdr-cursor-store.ts'
import {
  HerdrApiError,
  HerdrTerminalSession,
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
    workspace_id: 'w-test',
    tab_id: 't-1',
    pane_id: 'p-1',
    interactive_ready: true,
    cwd,
    revision: 1,
    state_change_seq: 100,
    ...overrides,
  }
}

interface Fake {
  client: HerdrApiClient
  reads: Record<string, unknown>[]
  prompts: Record<string, unknown>[]
  keys: Record<string, unknown>[]
  /** Name the ownership tags answer to, set by spawn(). */
  sessionName: string
  /** Mutated by a test to model what Herdr would report next. */
  state: { agent: HerdrAgentInfo; screen: string }
  /** Optional per-test behavior for agent.prompt; default: leaves state alone. */
  onPrompt?: (params: Record<string, unknown>) => void
}

function makeFake(initial: { agent?: HerdrAgentInfo; screen?: string } = {}): Fake {
  const fake: Fake = {
    reads: [],
    prompts: [],
    keys: [],
    sessionName: '',
    state: { agent: initial.agent ?? agent(), screen: initial.screen ?? '' },
    client: {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') {
          return { workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        }
        if (method === 'workspace.report_metadata') return {}
        if (method === 'agent.start') return { agent: fake.state.agent }
        if (method === 'agent.get') return { agent: fake.state.agent }
        if (method === 'agent.prompt') {
          fake.prompts.push(params)
          fake.onPrompt?.(params)
          return { agent: fake.state.agent }
        }
        if (method === 'agent.read') {
          fake.reads.push(params)
          // Herdr's real revision for an agent pane: always 0.
          return { read: { text: fake.state.screen, revision: 0 } }
        }
        if (method === 'workspace.get') {
          return {
            workspace: {
              workspace_id: 'w-test',
              tokens: { tandem_owner: await owner(), tandem_session: fake.sessionName, tandem_engine: 'claude' },
            },
          }
        }
        if (method === 'agent.send_keys') {
          fake.keys.push(params)
          return {}
        }
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  return fake
}

function spawn(fake: Fake, name: string): Promise<HerdrTerminalSession> {
  fake.sessionName = name
  // A process-local store: these tests must never touch the real Tandem state
  // directory under the developer's home.
  return HerdrTerminalSession.spawn({
    name,
    engine: 'claude',
    cwd,
    allowlist: [cwd],
    ownerIdProvider: owner,
  }, fake.client, new MemoryHerdrCursorStore())
}

describe('Herdr repeat turns', () => {
  it('reports only the SECOND turn\'s new output, never the first turn\'s answer again', async () => {
    const fake = makeFake()
    const session = await spawn(fake, 'repeat-turns')

    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'done', state_change_seq: 102 })
      fake.state.screen = ['> turn one', 'ANSWER ONE'].join('\n')
    }
    const first = await session.send('turn one')
    expect(first.status).toBe('done')
    expect(first.report).toContain('ANSWER ONE')

    // The second turn's window still carries the whole first turn: this is
    // exactly what a real recent_unwrapped read looks like.
    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'done', state_change_seq: 104 })
      fake.state.screen = ['> turn one', 'ANSWER ONE', '> turn two', 'ANSWER TWO'].join('\n')
    }
    const second = await session.send('turn two')
    expect(second.status).toBe('done')
    expect(second.report).toContain('ANSWER TWO')
    expect(second.report).not.toContain('ANSWER ONE')
    expect(second.cursor).toBeGreaterThan(first.cursor)
  })

  it('does not end the turn on the PREVIOUS turn\'s settled state, and delivers the real output once Herdr observes the transition', async () => {
    const fake = makeFake()
    const session = await spawn(fake, 'stale-settled')

    // Turn one, so there is a baseline transcript.
    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'done', state_change_seq: 102 })
      fake.state.screen = ['> turn one', 'ANSWER ONE'].join('\n')
    }
    await session.send('turn one')

    // Turn two: Herdr's wait returns while its detection loop is still
    // reporting the settled state of turn ONE — same state_change_seq, same
    // screen. Believing it would report turn one's answer as turn two's.
    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'done', state_change_seq: 102 })
    }
    const second = await session.send('turn two')
    expect(second.status).toBe('running')
    expect(second.report).toBe('')

    // Poll while Herdr still reports the stale settled state: NOT idle, so a
    // poll loop keeps going instead of stopping one turn early.
    const stalePoll = await session.readSince(second.cursor)
    expect(stalePoll.idle).toBe(false)
    expect(stalePoll.text).toBe('')

    // The turn genuinely finishes: lifecycle counter moves past submission.
    fake.state.agent = agent({ agent_status: 'done', state_change_seq: 104 })
    fake.state.screen = ['> turn one', 'ANSWER ONE', '> turn two', 'ANSWER TWO'].join('\n')
    const settledPoll = await session.readSince(stalePoll.cursor)
    expect(settledPoll.idle).toBe(true)
    expect(settledPoll.text).toContain('ANSWER TWO')
    expect(settledPoll.text).not.toContain('ANSWER ONE')
  })

  it('an interrupted turn stops holding the poll loop open', async () => {
    const fake = makeFake()
    const session = await spawn(fake, 'interrupted')
    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'working', state_change_seq: 101 })
      throw new HerdrApiError('timeout', 'timed out')
    }
    const sent = await session.send('long thing')
    expect(sent.status).toBe('running')

    // Interrupt settles the agent without a completion of its own: the turn
    // it cancelled will never produce the transition the poll loop waits for.
    fake.state.agent = agent({ agent_status: 'idle', state_change_seq: 101 })
    await session.interrupt()
    expect(fake.keys).toHaveLength(1)

    const page = await session.readSince(sent.cursor)
    expect(page.idle).toBe(true)
  })
})

describe('Herdr cursor and read churn', () => {
  it('a turn that outlives the soft cap is still delivered, even though every Herdr read reports revision 0', async () => {
    const fake = makeFake()
    const session = await spawn(fake, 'long-turn-revision-zero')
    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'working', state_change_seq: 101 })
      throw new HerdrApiError('timeout', 'timed out')
    }
    const sent = await session.send('something slow')
    expect(sent.status).toBe('running')
    expect(fake.reads).toHaveLength(0)

    fake.state.agent = agent({ agent_status: 'done', state_change_seq: 102 })
    fake.state.screen = 'LATE ANSWER'
    const page = await session.readSince(sent.cursor)
    expect(page.idle).toBe(true)
    expect(page.text).toBe('LATE ANSWER')
    expect(page.cursor).toBeGreaterThan(sent.cursor)
  })

  it('re-polling with the same cursor returns nothing, and an older cursor replays the same output', async () => {
    const fake = makeFake({ screen: 'ONE LINE' })
    const session = await spawn(fake, 'cursor-replay')
    const first = await session.readSince(0)
    expect(first.text).toBe('ONE LINE')

    const again = await session.readSince(first.cursor)
    expect(again.text).toBe('')
    expect(again.cursor).toBe(first.cursor)

    const replay = await session.readSince(0)
    expect(replay.text).toBe('ONE LINE')
  })

  it('polling a settled, unchanged session costs no scrollback read at all', async () => {
    const fake = makeFake({ screen: 'SETTLED' })
    const session = await spawn(fake, 'no-read-churn')
    await session.readSince(0)
    expect(fake.reads).toHaveLength(1)

    for (let i = 0; i < 5; i++) await session.readSince(1)
    // Same lifecycle state, nothing submitted: five more polls, no more reads.
    expect(fake.reads).toHaveLength(1)

    // A lifecycle change is what earns the next read.
    fake.state.agent = agent({ agent_status: 'done', state_change_seq: 106 })
    fake.state.screen = 'SETTLED\nAND THEN MORE'
    const page = await session.readSince(1)
    expect(fake.reads).toHaveLength(2)
    expect(page.text).toBe('AND THEN MORE')
  })

  it('a window that scrolled past everything already reported is delivered in full, not dropped', async () => {
    const fake = makeFake({ screen: 'first\nsecond' })
    const session = await spawn(fake, 'window-scrolled')
    const first = await session.readSince(0)
    expect(first.text).toBe('first\nsecond')

    fake.state.agent = agent({ agent_status: 'done', state_change_seq: 110 })
    fake.state.screen = 'ninety-eight\nninety-nine'
    const page = await session.readSince(first.cursor)
    expect(page.text).toBe('ninety-eight\nninety-nine')
  })
})

/**
 * Regression for a LIVE failure (2026-08-29, Claude Code 2.1.251 under Herdr
 * 0.8.2): an agent TUI redraws IN PLACE, so a turn's output lands in the
 * MIDDLE of the read window, between a stable head (banner, earlier turns)
 * and a stable tail (input box, status footer). Overlap-based de-duplication
 * found no suffix/prefix overlap between those two screens and re-delivered
 * the whole window, so the second turn's report carried the FIRST turn's
 * answer again. The screens below are the two Herdr reads from that run,
 * trimmed to the lines that matter.
 */
const LIVE_SCREEN_AFTER_TURN_ONE = [
  ' ▐▛███▛█   Claude Code v2.1.251',
  '▝▜██████▀  Opus 5 · Claude Max',
  '  ▝▝ ▝▝    /…/smoke/project',
  '',
  '❯ Run the bash command sleep 30. When it finishes, reply with exactly LIVE_LONG_TURN_OK and',
  '  nothing else.',
  '',
  '  Ran 2 shell commands',
  '',
  '⏺ Waiting for the background sleep 30 to finish.',
  '',
  '⏺ LIVE_LONG_TURN_OK',
  '',
  '─────────────────────────────────────────────',
  '❯',
  '─────────────────────────────────────────────',
  '  Opus 5 · high · /private/tmp/…',
  '                                         /rc',
].join('\n')

const LIVE_SCREEN_AFTER_TURN_TWO = [
  ' ▐▛███▛█   Claude Code v2.1.251',
  '▝▜██████▀  Opus 5 · Claude Max',
  '  ▝▝ ▝▝    /…/smoke/project',
  '',
  '❯ Run the bash command sleep 30. When it finishes, reply with exactly LIVE_LONG_TURN_OK and',
  '  nothing else.',
  '',
  '  Ran 2 shell commands',
  '',
  '⏺ Waiting for the background sleep 30 to finish.',
  '',
  '⏺ LIVE_LONG_TURN_OK',
  '',
  '❯ Reply with exactly LIVE_SECOND_TURN_OK and nothing else. Do not run any command.',
  '',
  '⏺ LIVE_SECOND_TURN_OK',
  '',
  '─────────────────────────────────────────────',
  '❯',
  '─────────────────────────────────────────────',
  '  Opus 5 · high · /private/tmp/…',
  '                                         /rc',
].join('\n')

describe('Herdr in-place TUI redraws', () => {
  it('reports only the lines inserted between an unchanged head and an unchanged footer', async () => {
    const fake = makeFake()
    const session = await spawn(fake, 'live-tui-shape')

    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'done', state_change_seq: 102 })
      fake.state.screen = LIVE_SCREEN_AFTER_TURN_ONE
    }
    const first = await session.send('turn one')
    expect(first.report).toContain('LIVE_LONG_TURN_OK')

    fake.onPrompt = () => {
      fake.state.agent = agent({ agent_status: 'done', state_change_seq: 104 })
      fake.state.screen = LIVE_SCREEN_AFTER_TURN_TWO
    }
    const second = await session.send('turn two')
    expect(second.status).toBe('done')
    // The whole point: the second turn's answer, and nothing from the first.
    expect(second.report).toContain('LIVE_SECOND_TURN_OK')
    expect(second.report).not.toContain('LIVE_LONG_TURN_OK')
    expect(second.report).not.toContain('Claude Code v2.1.251')
    expect(second.report).not.toContain('/rc')
    // Only the two inserted lines (the prompt echo and the answer), plus the
    // blank line between them.
    expect(second.report.split('\n').filter((line) => line.trim().length)).toEqual([
      '❯ Reply with exactly LIVE_SECOND_TURN_OK and nothing else. Do not run any command.',
      '⏺ LIVE_SECOND_TURN_OK',
    ])
  })

  it('reports nothing when only the TUI\'s own padding reflows', async () => {
    const fake = makeFake({ screen: 'ANSWER\n\n\n\n─────\n❯' })
    const session = await spawn(fake, 'padding-reflow')
    const first = await session.readSince(0)
    expect(first.text).toContain('ANSWER')

    fake.state.agent = agent({ agent_status: 'done', state_change_seq: 108 })
    fake.state.screen = 'ANSWER\n\n\n\n\n\n─────\n❯'
    const second = await session.readSince(first.cursor)
    expect(second.text).toBe('')
    expect(second.cursor).toBe(first.cursor)
  })
})
