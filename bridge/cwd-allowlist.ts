/** Canonical cwd admission shared by every terminal backend. */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

const HOME = homedir()

/** Resolve symlinks in the deepest existing ancestor, preserving a missing tail. */
export function safeResolve(p: string, home = HOME): string {
  let abs = resolve(p.replace(/^~(?=$|\/)/, home))
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(abs)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(abs)
      if (parent === abs) return tail.length ? join(abs, ...tail.reverse()) : abs
      tail.push(basename(abs))
      abs = parent
    }
  }
}

/** Build only explicitly configured roots. Missing or blank configuration fails closed. */
export function buildAllowlist(
  envValue = process.env.CCM_CWD_ALLOWLIST,
  home = HOME,
): string[] {
  if (!envValue?.trim()) return []
  return envValue
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => safeResolve(p, home))
}

/** True only for a canonical root itself or one of its descendants. */
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
