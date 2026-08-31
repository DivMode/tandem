/**
 * What Tandem adds to a Claude worker it spawns — and, just as importantly,
 * what it adds when the host has configured nothing.
 *
 * Two properties are load-bearing here:
 *
 *  1. UNCONFIGURED IS UNCHANGED. `TANDEM_CLAUDE_SETTINGS_PATH` unset must
 *     produce no `--settings` flag and no environment stamp, so a host that
 *     never opts in spawns exactly the argv it spawned before this phase.
 *  2. CONFIGURED-BUT-UNTRUSTWORTHY IS LOUD. The settings file names commands
 *     Claude will execute. Quietly dropping a bad one would leave the operator
 *     believing completion is reported by Claude itself when it is still being
 *     guessed from a terminal, so every refusal throws and says why.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ID_ENV, isOpaqueIdentity } from '../bridge/claude-lifecycle-store.ts'
import {
  CLAUDE_SETTINGS_PATH_ENV,
  ClaudeSettingsError,
  claudeWorkerArgv,
  claudeWorkerEnvironment,
  claudeWorkerSpawn,
  tandemSessionIdFor,
  validateClaudeSettingsPath,
} from '../bridge/claude-worker-env.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  // Under the hermetic per-worker state root test/setup-hermetic-env.ts
  // provisions (TANDEM_STATE_DIR), not the real OS tmpdir — so these fixtures
  // live inside the sandboxed, auto-cleaned run root like every other test's
  // state, rather than leaking real temp directories on the host.
  const base = process.env.TANDEM_STATE_DIR ?? tmpdir()
  const dir = mkdtempSync(join(base, 'tandem-settings-'))
  roots.push(dir)
  return dir
}

function settingsFile(contents = '{"hooks":{}}', mode = 0o600): string {
  const path = join(root(), 'settings.json')
  writeFileSync(path, contents, { mode })
  chmodSync(path, mode)
  return path
}

describe('validateClaudeSettingsPath', () => {
  it('accepts an owner-only regular JSON object file and returns it', () => {
    const path = settingsFile()
    expect(validateClaudeSettingsPath(path)).toBe(path)
  })

  it('refuses a relative path', () => {
    expect(() => validateClaudeSettingsPath('claude/settings.json')).toThrow(ClaudeSettingsError)
    expect(() => validateClaudeSettingsPath('claude/settings.json')).toThrow(/absolute/)
  })

  it('refuses an empty value rather than treating it as unset', () => {
    expect(() => validateClaudeSettingsPath('   ')).toThrow(/set but empty/)
  })

  it('accepts a whitespace-padded path, trimmed', () => {
    const path = settingsFile()
    expect(validateClaudeSettingsPath(`  ${path}  `)).toBe(path)
  })

  it('refuses a path that does not exist', () => {
    expect(() => validateClaudeSettingsPath(join(root(), 'missing.json'))).toThrow(/no such file/)
  })

  it('refuses a directory', () => {
    const dir = join(root(), 'settings.json')
    mkdirSync(dir)
    expect(() => validateClaudeSettingsPath(dir)).toThrow(/not a regular file/)
  })

  it('refuses a symlink, whose target can be repointed after the check', () => {
    const real = settingsFile()
    const link = join(root(), 'link.json')
    symlinkSync(real, link)
    expect(() => validateClaudeSettingsPath(link)).toThrow(/symlink/)
  })

  it('refuses a group- or world-writable file: it names commands Claude runs', () => {
    expect(() => validateClaudeSettingsPath(settingsFile('{}', 0o666))).toThrow(/writable/)
    expect(() => validateClaudeSettingsPath(settingsFile('{}', 0o620))).toThrow(/writable/)
  })

  it('refuses content that is not a JSON object', () => {
    expect(() => validateClaudeSettingsPath(settingsFile('not json'))).toThrow(/valid JSON/)
    expect(() => validateClaudeSettingsPath(settingsFile('[]'))).toThrow(/JSON object/)
    expect(() => validateClaudeSettingsPath(settingsFile('null'))).toThrow(/JSON object/)
  })

  it('refuses a file larger than the settings bound', () => {
    expect(() => validateClaudeSettingsPath(settingsFile(`{"pad":"${'x'.repeat(300 * 1024)}"}`))).toThrow(/larger than/)
  })
})

describe('tandemSessionIdFor', () => {
  it('is an opaque identity the lifecycle store will accept', () => {
    expect(isOpaqueIdentity(tandemSessionIdFor('reviewer', '/state'))).toBe(true)
  })

  it('is stable for the same installation and name — this is what survives a restart', () => {
    expect(tandemSessionIdFor('reviewer', '/state')).toBe(tandemSessionIdFor('reviewer', '/state'))
  })

  it('separates names, and separates installations sharing a name', () => {
    expect(tandemSessionIdFor('reviewer', '/state')).not.toBe(tandemSessionIdFor('builder', '/state'))
    expect(tandemSessionIdFor('reviewer', '/state')).not.toBe(tandemSessionIdFor('reviewer', '/other'))
  })

  it('carries no project, path, or client text', () => {
    expect(tandemSessionIdFor('reviewer', '/home/pat/.tandem')).toMatch(/^ts_[0-9a-f]{32}$/)
  })
})

describe('claudeWorkerSpawn', () => {
  it('adds nothing at all when the host configured no settings file', () => {
    expect(claudeWorkerSpawn('worker', {}, '/state')).toBeUndefined()
    expect(claudeWorkerSpawn('worker', { [CLAUDE_SETTINGS_PATH_ENV]: '' }, '/state')).toBeUndefined()
    expect(claudeWorkerArgv(undefined)).toEqual([])
    expect(claudeWorkerEnvironment(undefined)).toEqual({})
  })

  it('supplies the settings flag and the session stamp when configured', () => {
    const path = settingsFile()
    const worker = claudeWorkerSpawn('worker', { [CLAUDE_SETTINGS_PATH_ENV]: path }, '/state')

    expect(worker).toEqual({ settingsPath: path, sessionId: tandemSessionIdFor('worker', '/state') })
    expect(claudeWorkerArgv(worker)).toEqual(['--settings', path])
    expect(claudeWorkerEnvironment(worker)).toEqual({ [SESSION_ID_ENV]: tandemSessionIdFor('worker', '/state') })
  })

  it('trims a whitespace-padded configured path the same way an untrimmed one would fail', () => {
    const path = settingsFile()
    const worker = claudeWorkerSpawn('worker', { [CLAUDE_SETTINGS_PATH_ENV]: `  ${path}  ` }, '/state')
    expect(worker).toEqual({ settingsPath: path, sessionId: tandemSessionIdFor('worker', '/state') })
  })

  it('treats a whitespace-only value as unset, same as empty', () => {
    expect(claudeWorkerSpawn('worker', { [CLAUDE_SETTINGS_PATH_ENV]: '   ' }, '/state')).toBeUndefined()
  })

  it('throws rather than silently dropping a configured-but-unusable path', () => {
    expect(() => claudeWorkerSpawn('worker', { [CLAUDE_SETTINGS_PATH_ENV]: '/nope/settings.json' }, '/state')).toThrow(
      ClaudeSettingsError,
    )
  })

  it('names the variable in the error so the operator knows what to fix', () => {
    expect(() => claudeWorkerSpawn('worker', { [CLAUDE_SETTINGS_PATH_ENV]: 'relative.json' }, '/state')).toThrow(
      new RegExp(CLAUDE_SETTINGS_PATH_ENV),
    )
  })
})
