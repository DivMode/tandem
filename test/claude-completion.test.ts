/**
 * The baseline: what makes a `Stop` record evidence about THIS turn.
 *
 * The lifecycle store is append-only and shared by every Tandem-driven Claude
 * on the host, so a record only says something about the turn in flight if it
 * was written after that turn started. These tests pin the two halves of that:
 * claudeTurnEndAfter's reading of the store, and the turn ledger's DURABLE
 * carrying of the baseline — the part a bridge restart and a cold re-adoption
 * depend on.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeLifecycleStore, MAX_RETAINED_EVENTS } from '../bridge/claude-lifecycle-store.ts'
import { claudeTurnEndAfter, isClaudeTurnBaseline, type ClaudeTurnBaseline } from '../bridge/claude-completion.ts'
import { TurnLedger } from '../bridge/turn-ledger.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

const WORKER = 'ts_worker'
const OTHER = 'ts_other'

function storeWithBaseline(): { store: ClaudeLifecycleStore; baseline: ClaudeTurnBaseline } {
  const store = new ClaudeLifecycleStore(dir('tandem-lifecycle-'))
  const cursor = store.snapshot()
  return { store, baseline: { session: WORKER, seq: cursor.seq, storeEpoch: cursor.storeEpoch } }
}

describe('claudeTurnEndAfter', () => {
  it('finds a Stop this worker reported after the baseline, with its final message', () => {
    const { store, baseline } = storeWithBaseline()
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'c1', message: 'all four tests pass' })

    expect(claudeTurnEndAfter(baseline, store)).toMatchObject({ kind: 'stop', message: 'all four tests pass' })
  })

  it('reports a StopFailure distinctly rather than flattening it to "done"', () => {
    const { store, baseline } = storeWithBaseline()
    store.record({ kind: 'stop_failure', tandemSession: WORKER, claudeSessionId: 'c1' })

    expect(claudeTurnEndAfter(baseline, store)).toMatchObject({ kind: 'stop_failure' })
    expect(claudeTurnEndAfter(baseline, store)?.message).toBeUndefined()
  })

  it('ignores a Stop that was already in the store when the turn opened', () => {
    const store = new ClaudeLifecycleStore(dir('tandem-lifecycle-'))
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'c0', message: 'the PREVIOUS turn' })
    const cursor = store.snapshot()

    expect(claudeTurnEndAfter({ session: WORKER, seq: cursor.seq, storeEpoch: cursor.storeEpoch }, store)).toBeUndefined()
  })

  it('ignores a boundary belonging to another worker, however recent', () => {
    const { store, baseline } = storeWithBaseline()
    store.record({ kind: 'stop', tandemSession: OTHER, claudeSessionId: 'c9', message: 'not ours' })

    expect(claudeTurnEndAfter(baseline, store)).toBeUndefined()
  })

  it('finds this worker record behind a crowd of records from other workers', () => {
    const { store, baseline } = storeWithBaseline()
    for (let i = 0; i < 120; i += 1) {
      store.record({ kind: 'stop', tandemSession: `ts_noise${i}`, claudeSessionId: `c${i}` })
    }
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'mine', message: 'mine' })

    expect(claudeTurnEndAfter(baseline, store)).toMatchObject({ kind: 'stop', message: 'mine' })
  })

  it('takes the FIRST boundary after the baseline: a later one belongs to a later turn', () => {
    const { store, baseline } = storeWithBaseline()
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'c1', message: 'first' })
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'c1', message: 'second' })

    expect(claudeTurnEndAfter(baseline, store)?.message).toBe('first')
  })

  it('claims nothing when the store was replaced under the baseline', () => {
    const { store, baseline } = storeWithBaseline()
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'c1' })

    expect(claudeTurnEndAfter({ ...baseline, storeEpoch: 'a-store-that-no-longer-exists' }, store)).toBeUndefined()
  })

  it('claims nothing when retention dropped past the baseline', () => {
    const { store } = storeWithBaseline()
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'c1' })
    const epoch = store.snapshot().storeEpoch
    for (let i = 0; i < MAX_RETAINED_EVENTS + 5; i += 1) {
      store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: `c${i}` })
    }

    expect(claudeTurnEndAfter({ session: WORKER, seq: 1, storeEpoch: epoch }, store)).toBeUndefined()
  })

  it('claims nothing when there is no baseline at all', () => {
    const { store } = storeWithBaseline()
    store.record({ kind: 'stop', tandemSession: WORKER, claudeSessionId: 'c1' })

    expect(claudeTurnEndAfter(undefined, store)).toBeUndefined()
  })

  it('degrades to "no answer" when the store is unreadable rather than failing the poll', () => {
    const directory = dir('tandem-lifecycle-')
    // A store that is not demonstrably ours degrades to empty by design...
    writeFileSync(join(directory, 'events.json'), 'not json at all\n', { mode: 0o600 })
    const corrupt = new ClaudeLifecycleStore(directory)
    expect(claudeTurnEndAfter({ session: WORKER, seq: 0, storeEpoch: '0' }, corrupt)).toBeUndefined()

    // ...and a store that throws outright must not escape into the caller.
    const throwing = {
      readAfter() {
        throw new Error('state directory is gone')
      },
    } as unknown as ClaudeLifecycleStore
    expect(claudeTurnEndAfter({ session: WORKER, seq: 0, storeEpoch: 'e' }, throwing)).toBeUndefined()
  })
})

describe('isClaudeTurnBaseline', () => {
  it('accepts a complete baseline and refuses a partial one', () => {
    expect(isClaudeTurnBaseline({ session: 'ts_a', seq: 0, storeEpoch: '0' })).toBe(true)
    expect(isClaudeTurnBaseline({ session: 'ts_a', seq: 0 })).toBe(false)
    expect(isClaudeTurnBaseline({ session: '', seq: 1, storeEpoch: 'e' })).toBe(false)
    expect(isClaudeTurnBaseline({ session: 'ts_a', seq: -1, storeEpoch: 'e' })).toBe(false)
    expect(isClaudeTurnBaseline({ session: 'ts_a', seq: 1.5, storeEpoch: 'e' })).toBe(false)
    expect(isClaudeTurnBaseline(null)).toBe(false)
  })
})

describe('the turn ledger carries the baseline durably', () => {
  const baseline: ClaudeTurnBaseline = { session: WORKER, seq: 7, storeEpoch: 'epoch-1' }

  it('hands back the baseline of the turn in flight', () => {
    const ledger = new TurnLedger(dir('tandem-turns-'))
    ledger.beginTurn('worker', 'id-1', baseline)

    expect(ledger.pendingBaseline('worker', 'id-1')).toEqual(baseline)
  })

  it('survives a bridge restart: a NEW ledger over the same state reads it back', () => {
    const directory = dir('tandem-turns-')
    new TurnLedger(directory).beginTurn('worker', 'id-1', baseline)

    // A different TurnLedger instance is what a restarted bridge holds.
    expect(new TurnLedger(directory).pendingBaseline('worker', 'id-1')).toEqual(baseline)
  })

  it('is not offered to a DIFFERENT incarnation answering to the same name', () => {
    const ledger = new TurnLedger(dir('tandem-turns-'))
    ledger.beginTurn('worker', 'id-1', baseline)

    expect(ledger.pendingBaseline('worker', 'id-2')).toBeUndefined()
  })

  it('is dropped by completeTurn, so a later record cannot end an already-reported turn', () => {
    const ledger = new TurnLedger(dir('tandem-turns-'))
    ledger.beginTurn('worker', 'id-1', baseline)
    ledger.completeTurn('worker', 'id-1')

    expect(ledger.pendingBaseline('worker', 'id-1')).toBeUndefined()
  })

  it('is dropped by abortTurn (interrupt) and by sessionRef (close)', () => {
    const interrupt = new TurnLedger(dir('tandem-turns-'))
    interrupt.beginTurn('worker', 'id-1', baseline)
    interrupt.abortTurn('worker', 'id-1')
    expect(interrupt.pendingBaseline('worker', 'id-1')).toBeUndefined()

    const close = new TurnLedger(dir('tandem-turns-'))
    close.beginTurn('worker', 'id-1', baseline)
    close.sessionRef('worker', 'id-1')
    expect(close.pendingBaseline('worker', 'id-1')).toBeUndefined()
  })

  it('is REPLACED, not inherited, when a second send supersedes the turn in flight', () => {
    const ledger = new TurnLedger(dir('tandem-turns-'))
    ledger.beginTurn('worker', 'id-1', baseline)
    const next: ClaudeTurnBaseline = { session: WORKER, seq: 42, storeEpoch: 'epoch-1' }
    const { superseded } = ledger.beginTurn('worker', 'id-1', next)

    expect(superseded).toBeDefined()
    expect(ledger.pendingBaseline('worker', 'id-1')).toEqual(next)
  })

  it('is absent for a turn opened without one (every non-Claude engine)', () => {
    const ledger = new TurnLedger(dir('tandem-turns-'))
    ledger.beginTurn('worker', 'id-1')

    expect(ledger.pendingBaseline('worker', 'id-1')).toBeUndefined()
    expect(ledger.inspect('worker')).toMatchObject({ pendingTurn: 1 })
  })

  it('refuses a persisted entry whose baseline is malformed rather than half-trusting it', () => {
    const directory = dir('tandem-turns-')
    const ledger = new TurnLedger(directory)
    ledger.beginTurn('worker', 'id-1', baseline)
    // Corrupt the on-disk baseline the way a partial write or a hand-edit would.
    const file = join(directory, `${createHash('sha256').update('worker').digest('hex').slice(0, 32)}.json`)
    const state = JSON.parse(readFileSync(file, 'utf8'))
    state.lifecycle = { session: 'ts_worker' }
    writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 })

    expect(new TurnLedger(directory).inspect('worker')).toBeUndefined()
  })
})
