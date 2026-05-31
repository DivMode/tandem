/**
 * terminal-session.ts — drive a REAL interactive `claude` TUI inside tmux.
 *
 * BILLING (see spec §1b): we manipulate Max's real interactive `claude` TUI via
 * terminal keystrokes — NOT `claude -p` / headless — so usage stays on his
 * subscription windows. The bridge SPAWNS a fresh interactive claude inside a
 * tmux session ("tmux new-session -d -s ccm-<name> claude") and drives it by
 * injecting keys + scraping the pane. Max can "tmux attach -t ccm-<name>" to
 * watch or type alongside.
 *
 * IDLE DETECTION (the crux — empirically probed, see bridge/NOTES-terminal.md):
 *   Working marker  = the footer string "esc to interrupt" is PRESENT.
 *   Idle            = "esc to interrupt" ABSENT *and* the trimmed capture-pane
 *                     content is byte-stable across IDLE_STABLE_POLLS (default 3)
 *                     consecutive ~750ms polls. The two-condition rule matters:
 *                     right after Enter there is a brief window where the spinner
 *                     hasn't rendered yet (footer still shows "auto mode on"), so
 *                     a single glance can falsely read as idle — content-stability
 *                     guards against that.
 *
 * INJECTION SAFETY: text is injected with
 *   tmux send-keys -t <tgt> -l -- <text>     (literal; -- ends option parsing)
 * then a SEPARATE
 *   tmux send-keys -t <tgt> Enter
 * The user's text is passed as an execFile argv element, never interpolated into
 * a shell string, so it can never be reinterpreted as tmux key names or shell
 * metacharacters.
 *
 * TRANSCRIPT + CURSOR: on spawn we attach
 *   tmux pipe-pane -o -t <tgt> 'cat >> <transcriptsDir>/<name>.log'
 * The append-only log's byte length is the cursor. readSince(offset) reads from a
 * byte offset and strips ANSI for a human-readable slice.
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { open, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

const HOME = homedir()
const TRANSCRIPTS_DIR = join(HOME, '.tandem', 'transcripts')

/** tmux session-name prefix. Only ccm-* sessions are drivable by the bridge. */
const SESSION_PREFIX = 'ccm-'

/** The footer string Claude Code shows ONLY while a turn is running. */
const WORKING_MARKER = 'esc to interrupt'

/** Trust-folder prompt shown on first run in an un-trusted directory. */
const TRUST_PROMPT_MARKER = 'trust this folder'

const POLL_MS = 750
const IDLE_STABLE_POLLS = 3 // consecutive stable polls required to call it idle
// Soft cap for a single send() wait, configurable via env TANDEM_WAIT_MS (ms).
// At the cap, send() returns status:'running' so the caller can call again — the
// proven idle/done detection below is unchanged; only this bound is tunable.
const SEND_SOFT_CAP_MS =
  Number(process.env.TANDEM_WAIT_MS) > 0 ? Number(process.env.TANDEM_WAIT_MS) : 25_000
const SEND_HARD_CAP_MS = 180_000 // a send() can never hang past this
const SPAWN_WARMUP_MS = 20_000 // max wait for the TUI to become ready on spawn
const PANE_WIDTH = 200
const PANE_HEIGHT = 50

export interface SpawnOptions {
  name: string
  cwd: string
  /** Allowlist roots; cwd is validated against this before spawning. */
  allowlist: string[]
}

export interface SendResult {
  report: string
  cursor: number
  status: 'done' | 'running'
}

export interface ReadResult {
  text: string
  cursor: number
  idle: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Run tmux with an argv array (never a shell string). Resolves stdout. */
function tmux(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`tmux ${args[0]} failed: ${stderr || error.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Strip ANSI escape sequences (CSI, OSC, single-char ESC) from a UTF-8 string.
 * The transcript MUST be decoded as UTF-8 first so box-drawing / status glyphs
 * survive; stripping happens on the decoded string.
 */
export function stripAnsi(input: string): string {
  return (
    input
      // OSC: ESC ] ... (BEL | ESC \)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ ... final-byte
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // other two-char ESC sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      .replace(/\r/g, '')
  )
}

/** A cwd-allowlist check mirroring sessions.ts (kept local so this module has no
 *  hard dependency cycle). The authoritative helpers live in sessions.ts; spawn
 *  callers should pass the same allowlist they built there. */
function isUnder(real: string, root: string): boolean {
  if (real === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return real.startsWith(prefix)
}

/** True if `cwd` resolves under any allowlist root (trailing-sep prefix guard). */
function isCwdAllowedLocal(cwd: string, allowlist: string[]): boolean {
  let real: string
  try {
    real = realpathSync(cwd)
  } catch {
    real = cwd
  }
  return allowlist.some((root) => isUnder(real, root))
}

export class TerminalSession {
  private readonly _name: string
  private readonly _cwd: string
  private readonly logPath: string

  // Explicit field assignment (NOT TS "parameter properties") — the bridge runs
  // under `node --experimental-strip-types`, whose strip-only mode rejects the
  // `private x: T` constructor-parameter shorthand.
  private constructor(name: string, cwd: string, logPath: string) {
    this._name = name
    this._cwd = cwd
    this.logPath = logPath
  }

  get name(): string {
    return this._name
  }

  get cwd(): string {
    return this._cwd
  }

  get tmuxTarget(): string {
    return SESSION_PREFIX + this._name
  }

  attachHint(): string {
    return `tmux attach -t ${this.tmuxTarget}`
  }

  /**
   * Spawn a fresh interactive `claude` inside a new tmux session. The cwd is
   * validated against the allowlist (the caller should pass an already-realpath'd
   * cwd and the matching allowlist from sessions.ts). Attaches a pipe-pane
   * transcript and waits for the TUI to become ready (handling the first-run
   * trust-folder prompt).
   */
  static async spawn(opts: SpawnOptions): Promise<TerminalSession> {
    const { name, cwd, allowlist } = opts
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`invalid session name: ${name}`)
    }
    if (!allowlist.some((root) => isUnder(cwd, root))) {
      throw new Error(`cwd not allowed: ${cwd}`)
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`cwd does not exist or is not a directory: ${cwd}`)
    }

    const target = SESSION_PREFIX + name
    // Refuse to clobber an existing session of the same name.
    if (await TerminalSession.tmuxSessionExists(target)) {
      throw new Error(`tmux session already exists: ${target}`)
    }

    await mkdir(TRANSCRIPTS_DIR, { recursive: true })
    const logPath = join(TRANSCRIPTS_DIR, `${name}.log`)
    // Truncate any stale transcript so the byte cursor starts clean.
    await (await open(logPath, 'w')).close()

    // Inject text injection-safe — but here the args are all bridge-controlled
    // constants, so this is a normal new-session. `claude` is the command run
    // INSIDE the pane; the cwd is set via -c.
    await tmux([
      'new-session',
      '-d',
      '-s',
      target,
      '-x',
      String(PANE_WIDTH),
      '-y',
      String(PANE_HEIGHT),
      '-c',
      cwd,
      'claude',
    ])

    // Attach the append-only transcript pipe. Single-quote the redirect target;
    // the path is bridge-controlled (transcripts dir + validated name).
    const safeLog = logPath.replace(/'/g, `'\\''`)
    await tmux(['pipe-pane', '-o', '-t', target, `cat >> '${safeLog}'`])

    const session = new TerminalSession(name, cwd, logPath)
    await session.warmup()
    return session
  }

  /**
   * Re-attach to an existing ccm-* session the bridge previously created.
   *
   * SECURITY (allowlist re-validation at the trust boundary): the session's REAL
   * cwd is read from tmux (`pane_current_path`) and re-checked against the SAME
   * allowlist spawn uses. Adoption is the only path into the registry that does
   * not run spawn's allowlist gate, so without this check a ccm-* session created
   * by hand outside the allowlist (e.g. `tmux new -s ccm-x -c /etc`) — or one
   * whose claude process later cd'd out of bounds — would become fully drivable
   * by a remote caller that just guesses/lists the name. We REFUSE to adopt (return
   * undefined) any session whose real cwd is not allowlisted, mirroring spawn.
   */
  static async attachExisting(
    name: string,
    allowlist: string[],
  ): Promise<TerminalSession | undefined> {
    const target = SESSION_PREFIX + name
    if (!(await TerminalSession.tmuxSessionExists(target))) return undefined
    const logPath = join(TRANSCRIPTS_DIR, `${name}.log`)
    // Read the cwd tmux recorded for the session (the session's actual pane cwd).
    let cwd = HOME
    try {
      cwd = (await tmux(['display-message', '-p', '-t', target, '#{pane_current_path}'])).trim() || HOME
    } catch {
      /* keep default */
    }
    // Re-validate the ADOPTED cwd against the allowlist — do not drive a session
    // whose real cwd is outside the boundary.
    if (!isCwdAllowedLocal(cwd, allowlist)) {
      return undefined
    }
    return new TerminalSession(name, cwd, logPath)
  }

  /** Public: does a ccm-<name> tmux session exist? (name is the bare name.) */
  static async exists(name: string): Promise<boolean> {
    return TerminalSession.tmuxSessionExists(SESSION_PREFIX + name)
  }

  private static async tmuxSessionExists(target: string): Promise<boolean> {
    try {
      await tmux(['has-session', '-t', target])
      return true
    } catch {
      return false
    }
  }

  /** capture-pane current visible content (ANSI already resolved by tmux -p). */
  private async capture(): Promise<string> {
    try {
      return await tmux(['capture-pane', '-p', '-t', this.tmuxTarget])
    } catch {
      return ''
    }
  }

  private isWorking(pane: string): boolean {
    return pane.includes(WORKING_MARKER)
  }

  /** Wait for the TUI to be ready: dismiss the first-run trust prompt if shown,
   *  then wait until the input box exists and nothing is working. */
  private async warmup(): Promise<void> {
    const deadline = Date.now() + SPAWN_WARMUP_MS
    let trusted = false
    while (Date.now() < deadline) {
      const pane = await this.capture()
      if (!trusted && pane.toLowerCase().includes(TRUST_PROMPT_MARKER)) {
        // Confirm "Yes, I trust this folder" (the highlighted default) with Enter.
        await tmux(['send-keys', '-t', this.tmuxTarget, 'Enter'])
        trusted = true
        await sleep(POLL_MS)
        continue
      }
      // Ready = the prompt box marker present and not working.
      if (pane.includes('❯') && !this.isWorking(pane)) return
      await sleep(POLL_MS)
    }
    // Don't hard-fail: the session may still be usable; the first send() will
    // simply observe idle via its own polling.
  }

  /**
   * Inject a (possibly multi-line) body into the input box WITHOUT submitting it.
   * Each line is sent as a discrete literal `-l --` argv element; between lines a
   * dedicated literal-newline keystroke (`send-keys -l -- "\n"`) inserts a SOFT
   * newline in the input box. No Enter is pressed here, so nothing is submitted —
   * the caller presses Enter exactly once afterward to submit the whole body as a
   * single prompt. Empty `text` injects nothing.
   */
  private async injectMultiline(text: string): Promise<void> {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // Dedicated literal newline = soft line break in the TUI input box.
        await tmux(['send-keys', '-t', this.tmuxTarget, '-l', '--', '\n'])
      }
      const line = lines[i]
      if (line.length > 0) {
        await tmux(['send-keys', '-t', this.tmuxTarget, '-l', '--', line])
      }
    }
  }

  /**
   * Inject text (injection-safe), submit with Enter, then wait for the turn to
   * complete. Returns status:'done' with the harvested report once idle, or
   * status:'running' if the soft cap (~25s) elapses first. A hard cap
   * (default 180s) guarantees send() can never hang forever.
   *
   * MULTI-LINE SAFETY (see bridge/NOTES-terminal.md "Multi-line input"): relay
   * seeds, wrapped worker reports, and operator injections contain EMBEDDED
   * newlines. We MUST NOT submit them line-by-line (first line firing a turn
   * before the rest is typed, then a stray Enter submitting a partial prompt).
   * Empirically (Claude Code v2.1.157) the TUI treats a literal `\n` inside the
   * input box as a SOFT newline, not a submit — but to be robust against terminal
   * / version variance we type each line as its own literal `-l --` argv and
   * insert the line break with a DEDICATED `send-keys -l -- "\n"` (a discrete
   * literal newline keystroke) between lines, never as part of a key-name-
   * interpretable blob. Only the FINAL standalone `Enter` keypress submits, so a
   * multi-line message is always exactly one prompt, one turn, one submit.
   */
  async send(text: string): Promise<SendResult> {
    const startCursor = this.cursor()

    await this.injectMultiline(text)
    // Separate Enter keypress submits the prompt (the single submit for the whole
    // multi-line body).
    await tmux(['send-keys', '-t', this.tmuxTarget, 'Enter'])

    const softDeadline = Date.now() + SEND_SOFT_CAP_MS
    const hardDeadline = Date.now() + SEND_HARD_CAP_MS

    // Give the spinner a moment to appear so we don't read the pre-spinner
    // "looks idle" window as completion.
    await sleep(POLL_MS)

    let stablePolls = 0
    let lastPane = ''
    for (;;) {
      const pane = await this.capture()
      const working = this.isWorking(pane)
      const trimmed = pane.trimEnd()

      if (!working && trimmed === lastPane) {
        stablePolls++
      } else {
        stablePolls = working ? 0 : 1
      }
      lastPane = trimmed

      const idle = !working && stablePolls >= IDLE_STABLE_POLLS
      if (idle) {
        return { report: await this.reportSince(startCursor), cursor: this.cursor(), status: 'done' }
      }
      if (Date.now() >= hardDeadline) {
        // Hard timeout: surface whatever we have and let the caller poll/read.
        return { report: await this.reportSince(startCursor), cursor: this.cursor(), status: 'running' }
      }
      if (Date.now() >= softDeadline) {
        return { report: '', cursor: this.cursor(), status: 'running' }
      }
      await sleep(POLL_MS)
    }
  }

  /** Current transcript byte length = the read cursor. */
  private cursor(): number {
    try {
      return statSync(this.logPath).size
    } catch {
      return 0
    }
  }

  /**
   * Read the ANSI-stripped transcript slice since a byte offset, plus the new
   * cursor and whether the session is currently idle. Synchronous-ish: reads the
   * file from `cursor` to EOF.
   */
  async readSince(cursor: number): Promise<ReadResult> {
    const size = this.cursor()
    const text = stripAnsi(await this.readRaw(cursor, size))
    const pane = await this.capture()
    return { text, cursor: size, idle: !this.isWorking(pane) }
  }

  /** Read raw transcript bytes in [from, to) as UTF-8. */
  private async readRaw(from: number, to: number): Promise<string> {
    const start = Math.max(0, Math.min(from, to))
    if (to <= start) return ''
    const fh = await open(this.logPath, 'r')
    try {
      const buf = Buffer.alloc(to - start)
      await fh.read(buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      await fh.close()
    }
  }

  /**
   * Harvest a human-readable report once the turn is idle. The raw transcript
   * delta is extremely noisy — the TUI repaints the whole screen every frame and
   * interleaves animated spinner frames ("✻ Boondoggling…", "✳ Churned for 2s",
   * progress lines). The settled final screen (capture-pane) is the cleanest
   * representation of "what happened", so we use that as the report, cleaned of
   * the input-box chrome and footer. If capture-pane is empty we fall back to a
   * de-duplicated, spinner-filtered slice of the transcript delta. The full raw
   * (ANSI-stripped) transcript is always available via readSince() for review.
   */
  private async reportSince(cursor: number): Promise<string> {
    const pane = await this.capture()
    const fromPane = this.cleanReportLines(pane.split('\n'))
    if (fromPane) return fromPane
    const size = this.cursor()
    if (size <= cursor) return ''
    const stripped = stripAnsi(await this.readRaw(cursor, size))
    return this.cleanReportLines(stripped.split('\n'))
  }

  /** Drop blank/duplicate lines, spinner frames, progress lines, the input box,
   *  the bordered rules, and the status footer. */
  private cleanReportLines(lines: string[]): string {
    const out: string[] = []
    for (const line of lines) {
      const t = line.trimEnd()
      const trimmed = t.trim()
      if (!trimmed) continue
      // Bordered horizontal rules around the input box.
      if (/^[─-]{4,}$/.test(trimmed)) continue
      // Spinner frames: a leading status glyph then a "…"-terminated gerund or a
      // "<verb>ed for Ns" completion line.
      if (/^[✻✶✳✺✷✸✹✢✣·*●○◦]\s/.test(trimmed) && /(…|for \d+s|\bup\b|tokens)/.test(trimmed)) continue
      // The empty input prompt / "esc to interrupt" footer / auto-mode footer.
      if (trimmed === '❯' || trimmed.startsWith('❯ ←')) continue
      if (trimmed.includes('auto mode on (shift+tab')) continue
      if (trimmed.includes(WORKING_MARKER)) continue
      if (out.length && out[out.length - 1] === t) continue
      out.push(t)
    }
    return out.join('\n').trim()
  }

  /** Interrupt a running turn: Escape (Claude Code's "esc to interrupt"), then
   *  a C-c as a fallback if the TUI is wedged. */
  async interrupt(): Promise<void> {
    try {
      await tmux(['send-keys', '-t', this.tmuxTarget, 'Escape'])
    } catch {
      /* fallthrough to C-c */
    }
    await sleep(150)
    try {
      await tmux(['send-keys', '-t', this.tmuxTarget, 'C-c'])
    } catch {
      /* best effort */
    }
  }

  /** Kill the tmux session. Idempotent. */
  async close(): Promise<void> {
    try {
      await tmux(['kill-session', '-t', this.tmuxTarget])
    } catch {
      /* already gone */
    }
  }
}
