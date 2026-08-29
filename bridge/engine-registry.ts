/**
 * engine-registry.ts — which engines are known, which are enabled, and whether
 * an enabled engine's executable is actually present (binding — Phase 2 outline:
 * "strict known-id parsing, Claude-only default, explicit opt-in for other
 * engines, injectable executable detection, typed disabled/unavailable errors,
 * engine resolver, and capability report").
 *
 * ENGINE BOUNDARY (spec "Safety defaults"): `claude` is enabled unconditionally
 * — it is the sole DEFAULT engine and cannot be disabled via config in this MVP.
 * `codex`, `shell`, and `hermes` are disabled unless explicitly named in
 * TANDEM_ENABLED_ENGINES (comma- or colon-separated).
 *
 * ORDERING (binding — Phase 2 correction E): the router MUST resolve enablement
 * and executable availability BEFORE cwd resolution, tmux lookup, spawn, or any
 * network side effect — resolveEngine() below does only that: no filesystem
 * access beyond an executable-presence check (injectable, so tests never shell
 * out to a real `which`), no tmux, no network.
 *
 * `claude` is exempt from the executable-presence check: Phase 1 never
 * preflighted it (a missing `claude` binary surfaces at spawn/warmup, exactly
 * as before), and unlike codex — a genuinely new, opt-in engine — adding a real
 * `which claude` subprocess call to the hot path of EVERY open_session
 * (including reusing an already-live session) would be both a needless
 * regression risk in production and a source of environment-dependent flake in
 * tests. codex/shell/hermes have no such Phase 1 baseline to preserve.
 */
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter as pathDelimiter, isAbsolute, join } from 'node:path'
import { CLAUDE_DESCRIPTOR, CODEX_DESCRIPTOR, SHELL_DESCRIPTOR, type EngineDescriptor, type EngineId } from './drivable.ts'

export const KNOWN_ENGINE_IDS: readonly EngineId[] = ['claude', 'codex', 'shell', 'hermes']

/** Tmux-hosted engines' descriptors, keyed by id. `hermes` has none — it is not
 *  tmux-hosted (see engines/hermes.ts). */
const TMUX_DESCRIPTORS: Partial<Record<EngineId, EngineDescriptor>> = {
  claude: CLAUDE_DESCRIPTOR,
  codex: CODEX_DESCRIPTOR,
  shell: SHELL_DESCRIPTOR,
}

/** Thrown when a caller-supplied engine id isn't one of KNOWN_ENGINE_IDS. */
export class UnknownEngineError extends Error {}

/** Thrown when a known engine id was not explicitly enabled. */
export class EngineDisabledError extends Error {}

/** Thrown when an enabled engine's required executable was not found. */
export class EngineUnavailableError extends Error {}

/** Strict known-id parsing: case-insensitive match against KNOWN_ENGINE_IDS,
 *  otherwise a clear UnknownEngineError (never a silent fallback to claude). */
export function parseEngineId(value: string): EngineId {
  const v = value.trim().toLowerCase()
  if ((KNOWN_ENGINE_IDS as readonly string[]).includes(v)) return v as EngineId
  throw new UnknownEngineError(`unknown engine: "${value}". Supported engines: ${KNOWN_ENGINE_IDS.join(', ')}.`)
}

/** Parse TANDEM_ENABLED_ENGINES into the explicit opt-in set. `claude` is
 *  ALWAYS included — it is the sole default-enabled engine and this MVP has no
 *  mechanism to disable it. Unset/blank enables no other engine. */
export function buildEnabledEngines(envValue = process.env.TANDEM_ENABLED_ENGINES): Set<EngineId> {
  const enabled = new Set<EngineId>(['claude'])
  if (!envValue?.trim()) return enabled
  for (const raw of envValue.split(/[,:]/)) {
    const t = raw.trim()
    if (!t) continue
    enabled.add(parseEngineId(t))
  }
  return enabled
}

/** Injectable executable-presence check — tests supply a fake so the registry
 *  never shells out to a real `which` (binding — Phase 2 correction G:
 *  automated tests may not launch a real engine executable). */
export type ExecutableDetector = (executable: string) => Promise<boolean>

/** Directories a Tandem-owned Herdr workspace will search, if any.
 *
 *  Availability has to be judged in the environment the agent will ACTUALLY
 *  run in. Under the Herdr backend that is the configured workspace PATH, not
 *  this process's PATH — Tandem itself never sees it. Judging by `which` alone
 *  made TANDEM_HERDR_WORKSPACE_PATH unreachable: the engine was reported
 *  unavailable and refused before any workspace could be created, so the one
 *  mechanism that exists to make an agent visible could never make it visible.
 *
 *  Measured 2026-08-29: with the ChatGPT desktop app's bundled Codex named in
 *  TANDEM_HERDR_WORKSPACE_PATH and codex enabled, list_devices still reported
 *  engines ["claude"] and open_session answered "no online device (including
 *  local) supports engine codex".
 *
 *  Gated on the backend by name rather than by importing the backend module,
 *  which keeps this file free of a dependency on the thing it is describing. */
function herdrWorkspaceSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  if ((env.TANDEM_TERMINAL_BACKEND ?? '').trim().toLowerCase() !== 'herdr') return []
  const configured = env.TANDEM_HERDR_WORKSPACE_PATH?.trim()
  if (!configured) return []
  return configured.split(pathDelimiter).filter((entry) => entry !== '' && isAbsolute(entry))
}

/** Default detector: an executable in the Herdr workspace PATH when one is
 *  configured, otherwise `which <bin>` on this process's PATH.
 *  macOS/Linux only, matching the rest of this repo's setup assumptions. */
export const detectExecutableOnPath: ExecutableDetector = async (executable) => {
  for (const directory of herdrWorkspaceSearchPath()) {
    try {
      await access(join(directory, executable), fsConstants.X_OK)
      return true
    } catch {
      // Not in this directory; keep looking, then fall back to PATH.
    }
  }
  return new Promise((resolve) => {
    execFile('which', [executable], (error) => resolve(!error))
  })
}

export interface ResolveEngineOptions {
  enabledEngines?: Set<EngineId>
  detectExecutable?: ExecutableDetector
}

export interface EngineResolution {
  readonly id: EngineId
  /** Present for tmux-hosted engines (claude/codex/shell); absent for hermes. */
  readonly descriptor?: EngineDescriptor
}

/**
 * Resolve and validate a caller-supplied engine id (or `undefined` → "claude").
 * Order: parse → enabled → executable-available. Throws typed errors on the
 * FIRST failing check and does nothing else — no cwd/tmux/network access, so
 * the router can call this before any side effect (binding — Phase 2
 * correction E).
 */
export async function resolveEngine(
  rawId: string | undefined,
  opts: ResolveEngineOptions = {},
): Promise<EngineResolution> {
  const id = rawId === undefined || rawId === '' ? 'claude' : parseEngineId(rawId)
  const enabled = opts.enabledEngines ?? buildEnabledEngines()
  if (!enabled.has(id)) {
    throw new EngineDisabledError(
      `engine "${id}" is disabled. Enable it by adding it to TANDEM_ENABLED_ENGINES.`,
    )
  }
  const descriptor = TMUX_DESCRIPTORS[id]
  if (id !== 'claude' && descriptor?.executable) {
    const detect = opts.detectExecutable ?? detectExecutableOnPath
    const available = await detect(descriptor.executable)
    if (!available) {
      throw new EngineUnavailableError(
        `engine "${id}" is enabled but its executable "${descriptor.executable}" was not found on PATH.`,
      )
    }
  }
  return { id, descriptor }
}

export interface EngineCapability {
  engine: EngineId
  enabled: boolean
  /** False when disabled. When enabled: false only if a required executable is
   *  missing (codex); always true when enabled for claude (exempt — see the
   *  module doc comment), shell (no fixed executable), and hermes (availability
   *  is a runtime loopback/config concern handled by its own adapter, not this
   *  registry). */
  available: boolean
}

/** Capability report across every known engine — used by device registration
 *  (Phase 3) and useful standalone for diagnostics today. Never throws; an
 *  unavailable/disabled engine is just reported as such. */
export async function capabilityReport(opts: ResolveEngineOptions = {}): Promise<EngineCapability[]> {
  const enabled = opts.enabledEngines ?? buildEnabledEngines()
  const detect = opts.detectExecutable ?? detectExecutableOnPath
  const out: EngineCapability[] = []
  for (const id of KNOWN_ENGINE_IDS) {
    const isEnabled = enabled.has(id)
    let available = false
    if (isEnabled) {
      const descriptor = TMUX_DESCRIPTORS[id]
      available = id !== 'claude' && descriptor?.executable ? await detect(descriptor.executable) : true
    }
    out.push({ engine: id, enabled: isEnabled, available })
  }
  return out
}
