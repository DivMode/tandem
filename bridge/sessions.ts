/**
 * sessions.ts — TerminalSession registry, live-session listing, and the
 * cwd-allowlist security helpers (the trust boundary the reviewer scrutinizes).
 *
 * ENGINE = tmux (see spec §1b/§2). A "session" is an interactive `claude` TUI
 * running in a tmux session named "ccm-<name>". The bridge spawns and drives it;
 * only ccm-* tmux sessions are ever drivable from claude.ai. listSessions()
 * reports the LIVE ccm-* tmux sessions (from `tmux ls`) with their cwd + an
 * attach hint, and best-effort merges recent ~/.claude/projects history so the
 * web chat can resume past work.
 *
 * The allowlist helpers (buildAllowlist / isCwdAllowed) are exported here and
 * consumed by bridge/index.ts and bridge/relay.ts. Rules (SECURITY):
 *   - realpath-canonicalize candidate + roots before comparing (defeats symlink
 *     and `..` escapes).
 *   - default allowlist = $HOME + $HOME's immediate non-dot child dirs.
 *   - explicit override via CCM_CWD_ALLOWLIST (colon-separated). When set, $HOME
 *     is NOT implicitly allowed.
 *   - prefix match uses a TRAILING SEPARATOR so "/Users/max" does not match
 *     "/Users/maxfoo" (prefix-confusion guard).
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { TerminalSession } from './terminal-session.ts'

const HOME = homedir()
const PROJECTS_DIR = join(HOME, '.claude', 'projects')
const SESSION_PREFIX = 'ccm-'

export interface SessionInfo {
  /** session name (without the ccm- prefix) for live sessions, or the history
   *  session-uuid for history-only entries. */
  id: string
  project: string
  cwd: string
  lastMessage: string
  updatedAt: number
  live: boolean
  /** present for live tmux sessions: how Max attaches to watch/type. */
  attachHint?: string
}

// ---- allowlist (the security boundary) ------------------------------------

/**
 * Resolve to an absolute, symlink-canonical path. For a path that doesn't yet
 * exist, realpath the deepest existing ancestor and re-append the rest, so a
 * not-yet-created child of an allowlisted (possibly symlinked) root still
 * canonicalizes under that root.
 */
export function safeResolve(p: string, home = HOME): string {
  let abs = resolve(p.replace(/^~(?=$|\/)/, home))
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(abs)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = resolve(abs, '..')
      if (parent === abs) return tail.length ? join(abs, ...tail.reverse()) : abs
      tail.push(abs.slice(parent.length + 1))
      abs = parent
    }
  }
}

/** Build the allowlist: explicit roots from env, else $HOME + its child dirs. */
export function buildAllowlist(
  envValue = process.env.CCM_CWD_ALLOWLIST,
  home = HOME,
): string[] {
  if (envValue && envValue.trim()) {
    return envValue
      .split(':')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => safeResolve(p, home))
  }
  const roots = new Set<string>([safeResolve(home, home)])
  try {
    for (const entry of readdirSync(home)) {
      if (entry.startsWith('.')) continue
      const full = join(home, entry)
      try {
        if (statSync(full).isDirectory()) roots.add(safeResolve(full, home))
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* home unreadable — just the home root */
  }
  return [...roots]
}

/** True if `candidate` resolves to an allowlisted root or a descendant of one.
 *  Prefix comparison uses a trailing separator so "/Users/max" does NOT match
 *  "/Users/maxfoo". */
export function isCwdAllowed(candidate: string, allowlist: string[]): boolean {
  let real: string
  try {
    real = safeResolve(candidate)
  } catch {
    return false
  }
  for (const root of allowlist) {
    if (real === root) return true
    const prefix = root.endsWith(sep) ? root : root + sep
    if (real.startsWith(prefix)) return true
  }
  return false
}

// ---- live TerminalSession registry ----------------------------------------

const registry = new Map<string, TerminalSession>()

export function getLive(name: string): TerminalSession | undefined {
  return registry.get(name)
}

export function registerLive(session: TerminalSession): void {
  registry.set(session.name, session)
}

export function unregisterLive(name: string): void {
  registry.delete(name)
}

export function liveSessionNames(): string[] {
  return [...registry.keys()]
}

// ---- tmux live listing ----------------------------------------------------

function tmux(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('tmux', args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`tmux ${args[0]} failed: ${stderr || error.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

interface LiveTmuxSession {
  name: string // without prefix
  target: string // ccm-<name>
  cwd: string
  createdAt: number
}

/** Enumerate live ccm-* tmux sessions with their cwd + creation time. */
export async function listLiveTmuxSessions(): Promise<LiveTmuxSession[]> {
  let raw: string
  try {
    raw = await tmux([
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_created}\t#{pane_current_path}',
    ])
  } catch {
    return [] // tmux absent or no server running
  }
  const out: LiveTmuxSession[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [name, created, cwd] = line.split('\t')
    if (!name || !name.startsWith(SESSION_PREFIX)) continue
    out.push({
      name: name.slice(SESSION_PREFIX.length),
      target: name,
      cwd: cwd || HOME,
      createdAt: Number(created) * 1000 || Date.now(),
    })
  }
  return out
}

// ---- ~/.claude/projects history (best-effort) -----------------------------

function decodeProjectDir(name: string): string {
  return name.replace(/-/g, '/')
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join(' ')
      .trim()
  }
  return ''
}

async function readHistoryFile(dir: string, file: string): Promise<SessionInfo | undefined> {
  const id = file.replace(/\.jsonl$/, '')
  const full = join(dir, file)
  let st
  try {
    st = await stat(full)
  } catch {
    return undefined
  }
  let cwd = decodeProjectDir(dir.slice(PROJECTS_DIR.length + 1))
  let lastMessage = ''
  try {
    const rawText = await readFile(full, 'utf8')
    const lines = rawText.split('\n').filter((l) => l.trim())
    let cwdFound = false
    for (const line of lines) {
      let o: Record<string, unknown>
      try {
        o = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!cwdFound && typeof o['cwd'] === 'string') {
        cwd = o['cwd'] as string
        cwdFound = true
      }
      const type = o['type']
      if (type === 'user' || type === 'assistant') {
        const msg = o['message'] as { content?: unknown } | undefined
        const txt = extractText(msg?.content)
        if (txt) lastMessage = txt
      }
    }
  } catch {
    /* keep decoded cwd + empty lastMessage */
  }
  return {
    id,
    project: cwd.split('/').filter(Boolean).pop() ?? cwd,
    cwd,
    lastMessage: lastMessage.slice(0, 200),
    updatedAt: st.mtimeMs,
    live: false,
  }
}

async function readHistory(): Promise<SessionInfo[]> {
  let projectDirs: string[]
  try {
    projectDirs = await readdir(PROJECTS_DIR)
  } catch {
    return []
  }
  const all: SessionInfo[] = []
  for (const projDir of projectDirs) {
    const dir = join(PROJECTS_DIR, projDir)
    let files: string[]
    try {
      const dstat = await stat(dir)
      if (!dstat.isDirectory()) continue
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const info = await readHistoryFile(dir, file)
      if (info) all.push(info)
    }
  }
  return all
}

// ---- merged listing -------------------------------------------------------

/**
 * List sessions for the MCP `list_sessions` tool: LIVE ccm-* tmux sessions first
 * (with attach hint), then recent ~/.claude/projects history. Sorted newest
 * first, limited.
 */
export async function listSessions(
  opts: { limit?: number; project?: string } = {},
): Promise<{ sessions: SessionInfo[] }> {
  const limit = opts.limit ?? 20
  const [live, history] = await Promise.all([listLiveTmuxSessions(), readHistory()])

  const all: SessionInfo[] = []
  for (const s of live) {
    all.push({
      id: s.name,
      project: s.cwd.split('/').filter(Boolean).pop() ?? s.cwd,
      cwd: s.cwd,
      lastMessage: '',
      updatedAt: s.createdAt,
      live: true,
      attachHint: `tmux attach -t ${s.target}`,
    })
  }
  for (const h of history) all.push(h)

  const filtered = opts.project
    ? all.filter((s) => s.cwd.includes(opts.project as string) || s.project === opts.project)
    : all

  filtered.sort((a, b) => {
    // Live sessions always sort above history.
    if (a.live !== b.live) return a.live ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
  return { sessions: filtered.slice(0, limit) }
}
