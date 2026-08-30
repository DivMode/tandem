/**
 * Tandem's own Herdr session: selection, the Tandem-owned silent config, and
 * the headless start of that session.
 *
 * The property under test throughout is that the HUMAN's Herdr — their
 * `default` session, their ~/.config/herdr/config.toml, and any server Tandem
 * was not asked to manage — is never started, stopped, rewritten, or reloaded.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HERDR_SESSION,
  SILENT_HERDR_CONFIG,
  TANDEM_CONFIG_MARKER,
  ensureHerdrSessionSocket,
  herdrAttachPrefix,
  herdrConfigPath,
  herdrSessionIsManaged,
  herdrSessionName,
  resolveHerdrSocketPath,
  writeSilentHerdrConfig,
  type HerdrSessionIo,
} from '../bridge/herdr-session.ts'

interface Recorder {
  io: HerdrSessionIo
  runs: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }>
  starts: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>
  files: Map<string, string>
}

function recorder(options: {
  sessions?: () => unknown
  /** Sessions reported once the server has been started. */
  afterStart?: () => unknown
  files?: Record<string, string>
} = {}): Recorder {
  const rec: Recorder = {
    runs: [],
    starts: [],
    files: new Map(Object.entries(options.files ?? {})),
    io: {
      run: async (file, args, env) => {
        rec.runs.push({ file, args, env })
        const source = rec.starts.length && options.afterStart ? options.afterStart : options.sessions
        return JSON.stringify(source ? source() : { sessions: [] })
      },
      start: (file, args, env) => {
        rec.starts.push({ file, args, env })
      },
      readFile: async (path) => {
        const content = rec.files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      writeFile: async (path, content) => {
        rec.files.set(path, content)
      },
      sleep: async () => {},
    },
  }
  return rec
}

const running = (name: string, socket = `/tmp/${name}.sock`) => ({
  sessions: [
    { name: 'default', running: true, socket_path: '/tmp/default.sock' },
    { name, running: true, socket_path: socket },
  ],
})

const onlyDefault = () => ({
  sessions: [{ name: 'default', running: true, socket_path: '/tmp/default.sock' }],
})

describe('Herdr session selection', () => {
  it('drives Tandem\'s own session by default, never the human\'s', () => {
    expect(herdrSessionName({})).toBe(DEFAULT_HERDR_SESSION)
    expect(DEFAULT_HERDR_SESSION).not.toBe('default')
    expect(herdrSessionName({ TANDEM_HERDR_SESSION: 'work' })).toBe('work')
    expect(() => herdrSessionName({ TANDEM_HERDR_SESSION: '-bad name' })).toThrow(/invalid/)
  })

  it('manages its own named session, and never the human\'s default one', () => {
    expect(herdrSessionIsManaged({})).toBe(true)
    expect(herdrSessionIsManaged({ TANDEM_HERDR_SESSION: 'default' })).toBe(false)
    // Opt out for a named session an operator runs on their own terms.
    expect(herdrSessionIsManaged({ TANDEM_HERDR_MANAGED_SESSION: '0' })).toBe(false)
  })

  it('selects one running named session and rejects a stopped one without changing anything', async () => {
    const rec = recorder({
      sessions: () => ({
        sessions: [
          { name: 'default', running: true, socket_path: '/tmp/herdr.sock' },
          { name: 'stopped', running: false, socket_path: '/tmp/stopped.sock' },
        ],
      }),
    })
    await expect(resolveHerdrSocketPath({ TANDEM_HERDR_SESSION: 'default' }, rec.io)).resolves.toBe('/tmp/herdr.sock')
    await expect(resolveHerdrSocketPath({ TANDEM_HERDR_SESSION: 'stopped' }, rec.io)).rejects.toThrow(/not running/)
    expect(rec.starts).toEqual([])
  })

  it('names Tandem\'s session in the attach hint, and stays bare for the default one', () => {
    expect(herdrAttachPrefix({})).toBe(`herdr --session ${DEFAULT_HERDR_SESSION}`)
    expect(herdrAttachPrefix({ TANDEM_HERDR_SESSION: 'default' })).toBe('herdr')
    expect(herdrAttachPrefix({ TANDEM_HERDR_BIN: '/opt/bin/herdr' })).toBe(`/opt/bin/herdr --session ${DEFAULT_HERDR_SESSION}`)
  })
})

describe('Tandem-owned Herdr config', () => {
  it('lives under Tandem state, is silent, and is never the personal config file', () => {
    const path = herdrConfigPath({ HOME: '/home/person', TANDEM_STATE_DIR: '/home/person/.tandem' })
    expect(path).toBe(`/home/person/.tandem/herdr/${DEFAULT_HERDR_SESSION}.toml`)
    expect(SILENT_HERDR_CONFIG).toContain('delivery = "off"')
    expect(SILENT_HERDR_CONFIG).toContain('enabled = false')
    expect(() => herdrConfigPath({
      HOME: '/home/person',
      TANDEM_HERDR_CONFIG: '/home/person/.config/herdr/config.toml',
    })).toThrow(/personal Herdr config/)
    expect(() => herdrConfigPath({
      HOME: '/home/person',
      XDG_CONFIG_HOME: '/home/person/xdg',
      TANDEM_HERDR_CONFIG: '/home/person/xdg/herdr/config.toml',
    })).toThrow(/personal Herdr config/)
    expect(() => herdrConfigPath({ HOME: '/home/person', TANDEM_HERDR_CONFIG: 'relative/config.toml' }))
      .toThrow(/absolute path/)
  })

  it('writes the silent config once and refuses to overwrite a config Tandem does not own', async () => {
    const rec = recorder()
    await expect(writeSilentHerdrConfig('/state/herdr/tandem.toml', rec.io)).resolves.toBe('written')
    expect(rec.files.get('/state/herdr/tandem.toml')).toBe(SILENT_HERDR_CONFIG)
    // Idempotent: unchanged content is not rewritten.
    await expect(writeSilentHerdrConfig('/state/herdr/tandem.toml', rec.io)).resolves.toBe('unchanged')

    const foreign = recorder({ files: { '/home/person/herdr.toml': '[keys]\nquit = "ctrl+q"\n' } })
    await expect(writeSilentHerdrConfig('/home/person/herdr.toml', foreign.io))
      .rejects.toThrow(/does not own/)
    expect(foreign.files.get('/home/person/herdr.toml')).toBe('[keys]\nquit = "ctrl+q"\n')
  })

  it('rewrites its own config when Tandem changes it', async () => {
    const stale = `${TANDEM_CONFIG_MARKER}\n# an older Tandem wrote this\n`
    const rec = recorder({ files: { '/state/herdr/tandem.toml': stale } })
    await expect(writeSilentHerdrConfig('/state/herdr/tandem.toml', rec.io)).resolves.toBe('written')
    expect(rec.files.get('/state/herdr/tandem.toml')).toBe(SILENT_HERDR_CONFIG)
  })
})

describe('Starting Tandem\'s Herdr session', () => {
  const env = { HOME: '/home/person', TANDEM_STATE_DIR: '/state' }

  it('uses the session when it is already running, starting nothing', async () => {
    const rec = recorder({ sessions: () => running(DEFAULT_HERDR_SESSION) })
    await expect(ensureHerdrSessionSocket(env, rec.io)).resolves.toBe(`/tmp/${DEFAULT_HERDR_SESSION}.sock`)
    expect(rec.starts).toEqual([])
    expect(rec.files.size).toBe(0)
  })

  it('starts its own session headlessly against the silent config, with no inherited Herdr context', async () => {
    const rec = recorder({ sessions: onlyDefault, afterStart: () => running(DEFAULT_HERDR_SESSION) })
    const socket = await ensureHerdrSessionSocket({
      ...env,
      // Tandem itself running inside somebody's Herdr pane: these must not
      // leak into the server it starts, or it talks to THAT server instead.
      HERDR_SOCKET_PATH: '/home/person/.config/herdr/herdr.sock',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_SESSION: 'somebody-elses',
    }, rec.io)
    expect(socket).toBe(`/tmp/${DEFAULT_HERDR_SESSION}.sock`)
    expect(rec.starts).toHaveLength(1)
    const started = rec.starts[0]
    expect(started.file).toBe('herdr')
    expect(started.args).toEqual(['server'])
    expect(started.env.HERDR_SESSION).toBe(DEFAULT_HERDR_SESSION)
    expect(started.env.HERDR_CONFIG_PATH).toBe(`/state/herdr/${DEFAULT_HERDR_SESSION}.toml`)
    expect(started.env.HERDR_DISABLE_SOUND).toBe('1')
    expect(started.env.HERDR_SOCKET_PATH).toBeUndefined()
    expect(started.env.HERDR_PANE_ID).toBeUndefined()
    expect(rec.files.get(`/state/herdr/${DEFAULT_HERDR_SESSION}.toml`)).toBe(SILENT_HERDR_CONFIG)
    // Nothing was asked of any running server: only `session list` ran.
    expect(rec.runs.every((run) => run.args.join(' ') === 'session list --json')).toBe(true)
  })

  it('never starts the human\'s default session, and never an unmanaged named one', async () => {
    const rec = recorder({ sessions: () => ({ sessions: [{ name: 'default', running: false }] }) })
    await expect(ensureHerdrSessionSocket({ ...env, TANDEM_HERDR_SESSION: 'default' }, rec.io))
      .rejects.toThrow(/not running/)

    const unmanaged = recorder({ sessions: onlyDefault })
    await expect(ensureHerdrSessionSocket({ ...env, TANDEM_HERDR_MANAGED_SESSION: '0' }, unmanaged.io))
      .rejects.toThrow(/not running/)

    expect(rec.starts).toEqual([])
    expect(unmanaged.starts).toEqual([])
    expect(rec.files.size).toBe(0)
    expect(unmanaged.files.size).toBe(0)
  })

  it('an explicit socket overrides everything and starts nothing', async () => {
    const rec = recorder({ sessions: onlyDefault })
    await expect(ensureHerdrSessionSocket({ ...env, TANDEM_HERDR_SOCKET: '/tmp/explicit.sock' }, rec.io))
      .resolves.toBe('/tmp/explicit.sock')
    expect(rec.runs).toEqual([])
    expect(rec.starts).toEqual([])
    await expect(ensureHerdrSessionSocket({ ...env, TANDEM_HERDR_SOCKET: 'relative.sock' }, rec.io))
      .rejects.toThrow(/absolute path/)
  })

  it('gives up rather than waiting forever when its session does not come up', async () => {
    const rec = recorder({ sessions: onlyDefault, afterStart: onlyDefault })
    await expect(ensureHerdrSessionSocket(env, rec.io, 0)).rejects.toThrow(/did not start/)
    expect(rec.starts).toHaveLength(1)
  })
})
