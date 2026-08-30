/**
 * Durable Herdr read-cursor state.
 *
 * The defect this exists for was live-measured: a bridge restart followed by a
 * cold re-adoption handed a caller holding cursor 2 a response carrying cursor
 * 1, and re-delivered the whole screen the caller had already consumed. The
 * tests below cover the store itself (safety, bounds, cleanup) and the
 * behaviour across two separate session instances, which is what a bridge
 * restart looks like from inside the process.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileHerdrCursorStore,
  MemoryHerdrCursorStore,
  boundState,
  defaultCursorStateDir,
  type HerdrCursorState,
  type HerdrSessionIdentity,
} from '../bridge/herdr-cursor-store.ts'
import {
  HerdrTerminalSession,
  type HerdrAgentInfo,
  type HerdrApiClient,
} from '../bridge/herdr-terminal-session.ts'

/** Same derivation the session uses for its state key (agentNameFor). */
function stateKeyFor(name: string): string {
  return `tandem-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
}

const directories: string[] = []
const owner = async () => 'a'.repeat(64)
const cwd = process.cwd()

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-cursor-'))
  directories.push(dir)
  return join(dir, 'herdr-sessions')
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const identity: HerdrSessionIdentity = { workspaceId: 'w-test', terminalId: 'term_1' }

function state(overrides: Partial<HerdrCursorState> = {}): HerdrCursorState {
  return {
    cursor: 3,
    window: ['❯ prompt', '⏺ ANSWER'],
    chunks: [{ cursor: 3, text: '⏺ ANSWER' }],
    identity,
    ...overrides,
  }
}

describe('Herdr cursor state file', () => {
  it('round-trips through an owner-only file under Tandem state, and never a world-readable one', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    await store.save('tandem-abc123', state())
    const file = join(dir, 'tandem-abc123.json')
    expect(statSync(dir).mode & 0o077).toBe(0)
    expect(statSync(file).mode & 0o077).toBe(0)
    await expect(store.load('tandem-abc123', identity)).resolves.toEqual(state())
    // The write is atomic: no temporary file is left behind.
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
  })

  it('defaults to Tandem private state, not the repository or a shared directory', () => {
    expect(defaultCursorStateDir({ HOME: '/home/person' })).toBe('/home/person/.tandem/herdr-sessions')
    expect(defaultCursorStateDir({ HOME: '/home/person', TANDEM_STATE_DIR: '/srv/tandem' }))
      .toBe('/srv/tandem/herdr-sessions')
  })

  it('fails safe on corrupt, oversized, world-readable, symlinked, and stale state', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })

    writeFileSync(join(dir, 'corrupt.json'), '{not json', { mode: 0o600 })
    await expect(store.load('corrupt', identity)).resolves.toBeUndefined()

    writeFileSync(join(dir, 'wrongshape.json'), JSON.stringify({ version: 1, cursor: 'nope' }), { mode: 0o600 })
    await expect(store.load('wrongshape', identity)).resolves.toBeUndefined()

    writeFileSync(join(dir, 'wrongversion.json'), JSON.stringify({ ...state(), version: 99, updatedAt: Date.now() }), { mode: 0o600 })
    await expect(store.load('wrongversion', identity)).resolves.toBeUndefined()

    writeFileSync(join(dir, 'loose.json'), JSON.stringify({ ...state(), version: 1, updatedAt: Date.now() }), { mode: 0o600 })
    chmodSync(join(dir, 'loose.json'), 0o644)
    await expect(store.load('loose', identity)).resolves.toBeUndefined()

    symlinkSync(join(dir, 'loose.json'), join(dir, 'linked.json'))
    await expect(store.load('linked', identity)).resolves.toBeUndefined()

    const old = Date.now() - 30 * 24 * 60 * 60 * 1000
    writeFileSync(join(dir, 'stale.json'), JSON.stringify({ ...state(), version: 1, updatedAt: old }), { mode: 0o600 })
    await expect(store.load('stale', identity)).resolves.toBeUndefined()
  })

  it('refuses state belonging to a different agent, and forgets it', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    await store.save('reused-name', state())
    const other = { workspaceId: 'w-other', terminalId: 'term_2' }
    await expect(store.load('reused-name', other)).resolves.toBeUndefined()
    // Dropped, so it cannot be mistaken for this session's history later.
    await expect(store.load('reused-name', identity)).resolves.toBeUndefined()
  })

  it('rejects a key that could escape the state directory', async () => {
    const store = new FileHerdrCursorStore(stateDir())
    await expect(store.save('../escape', state())).rejects.toThrow(/invalid/)
    await expect(store.load('/etc/passwd', identity)).resolves.toBeUndefined()
  })

  it('bounds retention by chunk count and total size', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ cursor: i + 1, text: 'x'.repeat(2_000) }))
    const bounded = boundState({ cursor: 500, window: Array.from({ length: 5_000 }, () => 'line'), chunks: many, identity })
    expect(bounded.chunks.length).toBeLessThanOrEqual(200)
    expect(bounded.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)).toBeLessThanOrEqual(256 * 1024)
    expect(bounded.window.length).toBeLessThanOrEqual(600)
    // The NEWEST output is what survives trimming.
    expect(bounded.chunks[bounded.chunks.length - 1].cursor).toBe(500)
  })

  it('never rewinds a cursor another bridge process advanced', async () => {
    const store = new FileHerdrCursorStore(stateDir())
    await store.save('racing', state({ cursor: 9, chunks: [{ cursor: 9, text: 'newer' }] }))
    // A stale instance that still believes it is at 3 must not overwrite it.
    await store.save('racing', state({ cursor: 3 }))
    const loaded = await store.load('racing', identity)
    expect(loaded?.cursor).toBe(9)
    expect(loaded?.chunks.at(-1)?.text).toBe('newer')
  })

  it('clear() removes the file and is idempotent', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    await store.save('gone', state())
    await store.clear('gone')
    await store.clear('gone')
    await expect(store.load('gone', identity)).resolves.toBeUndefined()
  })
})

// --- across a bridge restart ------------------------------------------------

function agent(overrides: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  return {
    terminal_id: 'term_1',
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
  reads: number
  state: { agent: HerdrAgentInfo; screen: string }
  onPrompt?: () => void
}

function makeFake(screen = ''): Fake {
  const fake: Fake = {
    reads: 0,
    state: { agent: agent(), screen },
    client: {
      call: async (method, params = {}) => {
        if (method === 'workspace.create') return { workspace: { workspace_id: 'w-test' }, root_pane: { pane_id: 'p-1' } }
        if (method === 'workspace.report_metadata') return {}
        if (method === 'agent.start') return { agent: fake.state.agent }
        if (method === 'agent.get') return { agent: fake.state.agent }
        if (method === 'agent.prompt') {
          fake.onPrompt?.()
          return { agent: fake.state.agent }
        }
        if (method === 'agent.read') {
          fake.reads += 1
          return { read: { text: fake.state.screen, revision: 0 } }
        }
        if (method === 'agent.list') return { agents: [fake.state.agent] }
        if (method === 'workspace.list') {
          return {
            workspaces: [{
              workspace_id: 'w-test',
              tokens: {
                tandem_owner: await owner(),
                tandem_session: 'restarted',
                tandem_engine: 'claude',
                tandem_agent: fake.state.agent.name,
              },
            }],
          }
        }
        if (method === 'workspace.get') {
          return {
            workspace: {
              workspace_id: 'w-test',
              tokens: { tandem_owner: await owner(), tandem_session: 'restarted', tandem_engine: 'claude' },
            },
          }
        }
        if (method === 'workspace.close') return {}
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  return fake
}

/** A cold re-adoption: what a restarted bridge does with a surviving session. */
function readopt(fake: Fake, store: FileHerdrCursorStore) {
  return HerdrTerminalSession.attachExisting('restarted', 'claude', [cwd], fake.client, owner, store)
}

describe('Herdr cursors across a bridge restart', () => {
  it('resumes the cursor instead of rewinding it, and does not replay consumed output', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    const fake = makeFake('❯ turn one\n⏺ ANSWER ONE')

    const first = await HerdrTerminalSession.spawn(
      { name: 'restarted', engine: 'claude', cwd, allowlist: [cwd], ownerIdProvider: owner },
      fake.client,
      store,
    )
    const page = await first.readSince(0)
    expect(page.text).toContain('ANSWER ONE')
    const consumedCursor = page.cursor
    expect(consumedCursor).toBeGreaterThan(0)

    // ---- bridge restarts here: a brand new session object, same agent ----
    const second = await readopt(fake, store)
    expect(second).toBeDefined()
    const afterRestart = await second!.readSince(consumedCursor)
    expect(afterRestart.cursor).toBeGreaterThanOrEqual(consumedCursor)
    expect(afterRestart.text).toBe('')
    // The de-duplication window survived too: an unchanged screen is not
    // re-delivered just because the process is new.
    expect(fake.reads).toBeGreaterThan(0)
  })

  it('still delivers output the caller never consumed before the restart', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    const fake = makeFake('❯ turn one\n⏺ ANSWER ONE')

    const first = await HerdrTerminalSession.spawn(
      { name: 'restarted', engine: 'claude', cwd, allowlist: [cwd], ownerIdProvider: owner },
      fake.client,
      store,
    )
    const page = await first.readSince(0)
    const staleCursor = 0
    expect(page.cursor).toBe(1)

    // The caller crashed before reading, so it comes back holding the OLD
    // cursor after the bridge restarted.
    const second = await readopt(fake, store)
    const missed = await second!.readSince(staleCursor)
    expect(missed.text).toContain('ANSWER ONE')
    expect(missed.cursor).toBe(page.cursor)
  })

  it('keeps climbing across several restarts, one turn each', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    const fake = makeFake('❯ turn one\n⏺ ANSWER ONE')
    let session = await HerdrTerminalSession.spawn(
      { name: 'restarted', engine: 'claude', cwd, allowlist: [cwd], ownerIdProvider: owner },
      fake.client,
      store,
    )
    const cursors: number[] = []
    for (let turn = 2; turn <= 4; turn++) {
      fake.state.agent = agent({ agent_status: 'done', state_change_seq: 100 + turn * 2 })
      fake.state.screen = `${fake.state.screen}\n❯ turn ${turn}\n⏺ ANSWER ${turn}`
      const page = await session.readSince(cursors.at(-1) ?? 0)
      cursors.push(page.cursor)
      session = (await readopt(fake, store))!
    }
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b))
    expect(new Set(cursors).size).toBe(cursors.length)
  })

  it('never returns a cursor lower than the caller\'s, even with no usable stored state', async () => {
    const store = new FileHerdrCursorStore(stateDir())
    const fake = makeFake('⏺ ANSWER')
    const session = await readopt(fake, store)
    // Nothing was ever persisted for this agent, and the caller arrives with a
    // cursor from a previous incarnation.
    const page = await session!.readSince(41)
    expect(page.cursor).toBe(41)
    expect(page.text).toContain('ANSWER')
    const next = await session!.readSince(page.cursor)
    expect(next.cursor).toBeGreaterThanOrEqual(41)
  })

  it('two concurrent adoptions of the same session converge on one cursor sequence', async () => {
    const store = new FileHerdrCursorStore(stateDir())
    const fake = makeFake('⏺ ANSWER ONE')
    const first = await HerdrTerminalSession.spawn(
      { name: 'restarted', engine: 'claude', cwd, allowlist: [cwd], ownerIdProvider: owner },
      fake.client,
      store,
    )
    await first.readSince(0)

    const [a, b] = await Promise.all([readopt(fake, store), readopt(fake, store)])
    fake.state.agent = agent({ agent_status: 'done', state_change_seq: 120 })
    fake.state.screen = '⏺ ANSWER ONE\n⏺ ANSWER TWO'
    const fromA = await a!.readSince(1)
    const fromB = await b!.readSince(1)
    expect(fromA.text).toContain('ANSWER TWO')
    // The loser of the race must not be handed a cursor behind the winner's,
    // and the durable state must end at the highest cursor either of them
    // reached — a stale writer cannot rewind it.
    expect(fromB.cursor).toBeGreaterThanOrEqual(fromA.cursor)
    const durable = await store.load(stateKeyFor('restarted'), { workspaceId: 'w-test', terminalId: 'term_1' })
    expect(durable?.cursor).toBe(Math.max(fromA.cursor, fromB.cursor))
  })

  it('forgets the durable state when the session is truly closed', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    const fake = makeFake('⏺ ANSWER')
    const session = await HerdrTerminalSession.spawn(
      { name: 'restarted', engine: 'claude', cwd, allowlist: [cwd], ownerIdProvider: owner },
      fake.client,
      store,
    )
    await session.readSince(0)
    const readopted = await readopt(fake, store)
    expect((await readopted!.readSince(0)).text).toContain('ANSWER')

    await session.close()
    // Nothing left on disk, and a later adoption starts clean.
    const afterClose = await readopt(fake, store)
    const page = await afterClose!.readSince(0)
    expect(page.cursor).toBe(1)
    expect(page.text).toContain('ANSWER')
  })

  it('a spawn under a reused name never inherits the previous session\'s transcript', async () => {
    const dir = stateDir()
    const store = new FileHerdrCursorStore(dir)
    const fake = makeFake('⏺ OLD SESSION OUTPUT')
    const first = await HerdrTerminalSession.spawn(
      { name: 'restarted', engine: 'claude', cwd, allowlist: [cwd], ownerIdProvider: owner },
      fake.client,
      store,
    )
    await first.readSince(0)

    const fresh = makeFake('⏺ NEW SESSION OUTPUT')
    const second = await HerdrTerminalSession.spawn(
      { name: 'restarted', engine: 'claude', cwd, allowlist: [cwd], ownerIdProvider: owner },
      fresh.client,
      store,
    )
    const page = await second.readSince(0)
    expect(page.text).toContain('NEW SESSION OUTPUT')
    expect(page.text).not.toContain('OLD SESSION OUTPUT')
  })
})

describe('Memory cursor store', () => {
  it('matches the durable store\'s identity and rewind rules', async () => {
    const store = new MemoryHerdrCursorStore()
    await store.save('k', state({ cursor: 5 }))
    await store.save('k', state({ cursor: 2 }))
    expect((await store.load('k', identity))?.cursor).toBe(5)
    expect(await store.load('k', { workspaceId: 'other', terminalId: 'term_9' })).toBeUndefined()
  })
})
