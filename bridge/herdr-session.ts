/**
 * Tandem's own Herdr session: which named session Tandem drives, the
 * Tandem-owned Herdr config that keeps that session SILENT, and the headless
 * start of that session when it is not running yet.
 *
 * WHY A DEDICATED SESSION: Tandem drives background agents. Herdr's normal
 * response to a background agent finishing work or needing input — a toast and
 * a sound — is exactly what the human wants for their OWN panes. Firing it for
 * every Tandem turn trains them to ignore it, so the honest fix is to keep
 * Tandem's agents out of the human's session rather than to turn the human's
 * notifications off.
 *
 * Herdr gives us both halves of that (verified against Herdr 0.8.2):
 *   - named sessions are independent servers with their own panes, workspaces,
 *     sockets and runtime state, but they "still share the same global config
 *     file" (Herdr's persistence docs), so a name alone is NOT silent;
 *   - `HERDR_CONFIG_PATH` overrides the config file for a server, so Tandem
 *     starts ITS session against a Tandem-owned config that disables toasts
 *     and sound.
 *
 * WHAT TANDEM WILL NOT DO, at any layer below:
 *   - read, write, or reload the human's ~/.config/herdr/config.toml;
 *   - start, stop, or reconfigure the `default` session, or any session it was
 *     not asked to manage;
 *   - reload the config of ANY running Herdr server, its own included. A
 *     config change takes effect the next time Tandem's session starts, which
 *     keeps a running server's behavior exactly what its operator started it
 *     with.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Herdr's own session-name grammar (`herdr session attach <name>`). */
const HERDR_SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/** Tandem's dedicated session name, used unless TANDEM_HERDR_SESSION says otherwise. */
export const DEFAULT_HERDR_SESSION = 'tandem'

/** Marker that proves a config file is Tandem's to rewrite (see writeSilentHerdrConfig). */
export const TANDEM_CONFIG_MARKER = '# tandem-managed-herdr-config'

/**
 * The whole Tandem Herdr config. Silence is the ONLY thing it asserts —
 * everything else stays on Herdr's defaults, so a Herdr upgrade changes
 * Tandem's session the same way it changes the human's.
 */
export const SILENT_HERDR_CONFIG = `${TANDEM_CONFIG_MARKER}
# Written by Tandem for its own named Herdr session, and rewritten whenever
# Tandem changes it. Personal Herdr configuration belongs in
# ~/.config/herdr/config.toml, which Tandem never reads or writes.
#
# Tandem drives background agents: their state changes are reported through the
# Tandem API, not to whoever is at the keyboard. Normal Herdr notifications
# stay on for every other session.
onboarding = false

[ui.toast]
delivery = "off"

[ui.sound]
enabled = false
`

export interface HerdrSessionIo {
  run: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>
  start: (file: string, args: string[], env: NodeJS.ProcessEnv) => void
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
}

interface HerdrSessionEntry {
  name?: string
  running?: boolean
  socket_path?: string
}

function execFileText(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((res, rej) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error) rej(new Error(`Herdr command failed: ${stderr.trim() || error.message}`))
      else res(stdout)
    })
  })
}

export const defaultHerdrSessionIo: HerdrSessionIo = {
  run: execFileText,
  start: (file, args, env) => {
    // Detached and unref'd: Tandem's session must outlive the bridge process
    // exactly like the human's own Herdr server does.
    spawn(file, args, { env, detached: true, stdio: 'ignore' }).unref()
  },
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { mode: 0o600 })
  },
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
}

/** The Herdr binary Tandem invokes for session-level (non-socket) commands. */
export function herdrBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.TANDEM_HERDR_BIN?.trim() || 'herdr'
}

/** The named Herdr session Tandem drives. Defaults to Tandem's own, not the human's. */
export function herdrSessionName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.TANDEM_HERDR_SESSION?.trim() || DEFAULT_HERDR_SESSION
  if (!HERDR_SESSION_RE.test(name)) throw new Error('TANDEM_HERDR_SESSION is invalid')
  return name
}

/**
 * Whether Tandem may create, start, and configure the selected session itself.
 * `default` is the human's session and is never managed, whatever the flag
 * says; TANDEM_HERDR_MANAGED_SESSION=0 opts out for a named session too, for
 * an operator who starts and configures that session on their own terms.
 */
export function herdrSessionIsManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  if (herdrSessionName(env) === 'default') return false
  return env.TANDEM_HERDR_MANAGED_SESSION?.trim() !== '0'
}

/** The human's own Herdr config locations, which Tandem never writes. */
function humanHerdrConfigPaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim() || homedir()
  const paths = [join(home, '.config', 'herdr', 'config.toml')]
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg && isAbsolute(xdg)) paths.push(join(xdg, 'herdr', 'config.toml'))
  const appData = env.APPDATA?.trim()
  if (appData && isAbsolute(appData)) paths.push(join(appData, 'herdr', 'config.toml'))
  return paths.map((path) => resolve(path))
}

/**
 * Tandem-owned Herdr config path: under Tandem's own state directory unless
 * TANDEM_HERDR_CONFIG names another absolute path. Never one of the human's
 * Herdr config locations — a mis-set variable must fail loudly here rather
 * than quietly become the config their next Herdr start reads.
 */
export function herdrConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TANDEM_HERDR_CONFIG?.trim()
  const path = configured
    ? resolve(configured)
    : join(
      resolve(env.TANDEM_STATE_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.tandem')),
      'herdr',
      `${herdrSessionName(env)}.toml`,
    )
  if (configured && !isAbsolute(configured)) throw new Error('TANDEM_HERDR_CONFIG must be an absolute path')
  if (humanHerdrConfigPaths(env).includes(path)) {
    throw new Error('TANDEM_HERDR_CONFIG must not be the personal Herdr config file')
  }
  return path
}

/**
 * Write Tandem's silent Herdr config, refusing anything that is not Tandem's
 * to rewrite: an existing file must carry TANDEM_CONFIG_MARKER. That is what
 * stops a mis-set TANDEM_HERDR_CONFIG from overwriting somebody's keybindings,
 * theme, and notification settings. Idempotent: identical content is not
 * rewritten.
 */
export async function writeSilentHerdrConfig(
  path: string,
  io: HerdrSessionIo = defaultHerdrSessionIo,
): Promise<'unchanged' | 'written'> {
  let existing: string | undefined
  try {
    existing = await io.readFile(path)
  } catch {
    existing = undefined
  }
  if (existing !== undefined && !existing.startsWith(TANDEM_CONFIG_MARKER)) {
    throw new Error(`refusing to overwrite a Herdr config Tandem does not own: ${path}`)
  }
  if (existing === SILENT_HERDR_CONFIG) return 'unchanged'
  await io.writeFile(path, SILENT_HERDR_CONFIG)
  return 'written'
}

/**
 * Environment for a Herdr command or server that must resolve the SELECTED
 * session. Every inherited HERDR_* value is dropped first: when Tandem runs
 * inside a Herdr pane, HERDR_SOCKET_PATH points at THAT session's socket and
 * silently wins over the session name (live-confirmed — `herdr server` started
 * from inside a Herdr pane refused with "herdr server is already running",
 * having resolved the inherited socket instead of the named session). Talking
 * to the wrong server is precisely the unrelated-server mutation this must
 * never do.
 */
function sessionCommandEnv(env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('HERDR_')) clean[key] = value
  }
  clean.HERDR_SESSION = herdrSessionName(env)
  return { ...clean, ...overrides }
}

async function listHerdrSessions(
  env: NodeJS.ProcessEnv,
  io: HerdrSessionIo,
): Promise<HerdrSessionEntry[]> {
  try {
    const raw = await io.run(herdrBinary(env), ['session', 'list', '--json'], sessionCommandEnv(env))
    return (JSON.parse(raw) as { sessions?: HerdrSessionEntry[] }).sessions ?? []
  } catch (error) {
    throw new Error(`could not inspect Herdr sessions: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function runningSocketOf(sessions: HerdrSessionEntry[], name: string): string | undefined {
  const selected = sessions.find((session) => session.name === name)
  if (!selected?.running || !selected.socket_path || !isAbsolute(selected.socket_path)) return undefined
  return selected.socket_path
}

/** Resolve the selected persistent Herdr session without changing any state. */
export async function resolveHerdrSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  io: HerdrSessionIo = defaultHerdrSessionIo,
): Promise<string> {
  const explicit = env.TANDEM_HERDR_SOCKET?.trim()
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('TANDEM_HERDR_SOCKET must be an absolute path')
    return explicit
  }
  const name = herdrSessionName(env)
  const socket = runningSocketOf(await listHerdrSessions(env, io), name)
  if (!socket) throw new Error(`Herdr session "${name}" is not running`)
  return socket
}

/**
 * Resolve the socket of the session Tandem drives, starting that session
 * headlessly against Tandem's silent config when Tandem owns it and it is not
 * running. Returns the absolute socket path.
 *
 * An unmanaged session (the human's `default`, or an operator-run named one)
 * is never started here: it is reported as not running, exactly as before.
 */
export async function ensureHerdrSessionSocket(
  env: NodeJS.ProcessEnv = process.env,
  io: HerdrSessionIo = defaultHerdrSessionIo,
  startTimeoutMs = 15_000,
): Promise<string> {
  // An explicit socket, the human's `default` session, and an operator-run
  // named session all take the read-only path: look, never touch.
  if (env.TANDEM_HERDR_SOCKET?.trim() || !herdrSessionIsManaged(env)) {
    return resolveHerdrSocketPath(env, io)
  }
  const name = herdrSessionName(env)
  const running = runningSocketOf(await listHerdrSessions(env, io), name)
  if (running) return running

  const configPath = herdrConfigPath(env)
  await writeSilentHerdrConfig(configPath, io)
  io.start(herdrBinary(env), ['server'], sessionCommandEnv(env, {
    HERDR_CONFIG_PATH: configPath,
    // Belt and braces: the config already disables sound; this disables
    // playback even if a future Herdr default re-enables it.
    HERDR_DISABLE_SOUND: '1',
  }))

  const deadline = Date.now() + startTimeoutMs
  for (;;) {
    await io.sleep(250)
    const socket = runningSocketOf(await listHerdrSessions(env, io), name)
    if (socket) return socket
    if (Date.now() >= deadline) {
      throw new Error(`Herdr session "${name}" did not start within ${startTimeoutMs}ms`)
    }
  }
}

/** `herdr [--session <name>]` prefix for human-facing attach hints. */
export function herdrAttachPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const binary = herdrBinary(env)
  const name = herdrSessionName(env)
  return name === 'default' ? binary : `${binary} --session ${name}`
}
