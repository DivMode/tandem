#!/usr/bin/env node
/**
 * tandem-claude-stop-hook — the STABLE, package-visible command for Claude's
 * `Stop` / `StopFailure` lifecycle hook.
 *
 * WHY THIS FILE EXISTS AT ALL. The hook is registered in a Claude settings
 * file as a literal command string, and that string has to survive being
 * written down: into an operator's settings JSON, into a Nix derivation, into
 * a Home Manager module. `node --experimental-strip-types
 * <somewhere>/src/claude-stop-hook.ts` is none of those things — it hard-codes
 * an interpreter flag whose necessity depends on the Node version, and a path
 * into a package's private layout. Under Nix that path is inside an immutable
 * store output whose hash changes on every rebuild, so a settings file naming
 * it breaks the next time the package is updated.
 *
 * A `bin` entry does survive. `nix` (or `npm install -g`, or a plain
 * `node_modules/.bin`) materialises this as `tandem-claude-stop-hook` on PATH,
 * or at a stable `${package}/bin/tandem-claude-stop-hook`, and THAT is what
 * goes in the settings file. The private layout behind it is then free to move.
 *
 * WHAT IT ADDS BEYOND THE SHEBANG. Tandem's sources are TypeScript executed by
 * Node's type stripping. That is on by default from Node 22.18, and needs
 * `--experimental-strip-types` before it — and a shebang cannot conditionally
 * pass a flag. So this shim imports the real entrypoint when the running Node
 * can load it, and otherwise re-executes it in a child Node that can.
 *
 * IT KEEPS THE THREE PROMISES src/claude-stop-hook.ts MAKES. Exit code is
 * always 0 — a non-zero Stop hook is surfaced to the user and can be fed back
 * to the model. Nothing is ever written to stdout. And stdin is passed
 * straight through, because Claude writes the hook payload there and waits.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../src/claude-stop-hook.ts', import.meta.url))

/** Hand the child the same stdin Claude wrote to, and never fail louder than 0. */
function runInChildNode() {
  try {
    spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', entry], {
      stdio: ['inherit', 'inherit', 'inherit'],
    })
  } catch {
    /* a hook that cannot run is a missed record, never a failed turn */
  }
  process.exit(0)
}

// `process.features.typescript` is "strip"/"transform" where Node can load a
// .ts entry as-is, absent or false where it cannot. The try/catch is the
// backstop: a load failure is the only way the import below can throw, because
// the entrypoint itself catches everything and exits 0 on its own.
if (process.features.typescript) {
  try {
    await import(new URL('../src/claude-stop-hook.ts', import.meta.url).href)
  } catch {
    runInChildNode()
  }
} else {
  runInChildNode()
}
