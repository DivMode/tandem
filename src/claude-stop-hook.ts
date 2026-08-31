/**
 * claude-stop-hook.ts — the command entrypoint for Claude's Stop/StopFailure hook.
 *
 * DO NOT REGISTER IT BY THIS PATH, AND NOT IN THE PERSONAL SETTINGS FILE.
 * Register the packaged `tandem-claude-stop-hook` command (see
 * bin/tandem-claude-stop-hook.mjs) in a Tandem-owned settings file, and point
 * `TANDEM_CLAUDE_SETTINGS_PATH` at that file so Tandem layers it onto the
 * workers it spawns with `--settings`:
 *
 *   {
 *     "hooks": {
 *       "Stop":        [{ "hooks": [{ "type": "command", "command": "tandem-claude-stop-hook" }] }],
 *       "StopFailure": [{ "hooks": [{ "type": "command", "command": "tandem-claude-stop-hook" }] }]
 *     }
 *   }
 *
 * `~/.claude/settings.json` is the user's own file, shared by every Claude they
 * start by hand; Tandem never reads or writes it. And this module's path is a
 * package-private one — under Nix it lives in an immutable store output whose
 * hash changes on every rebuild — which is why the `bin` entry exists at all.
 * See docs/claude-completion-hook.md for the exact operator wiring.
 *
 * Invoke the command directly rather than through `npm run`: npm writes its own
 * banner to stdout, and promise 3 below is that this hook writes nothing there.
 * The `hook:claude-stop` package script exists for running it by hand.
 *
 * Claude writes the payload to this process's stdin and waits for it to exit.
 * Everything that matters lives in bridge/claude-stop-hook.ts; this file is the
 * I/O shell around it, and its whole job is to make three promises hold no
 * matter what:
 *
 *   1. IT ALWAYS EXITS 0. Every failure path, including one this file did not
 *      anticipate, ends in exit code 0. A non-zero Stop hook is surfaced to the
 *      user, and on some events fed back to the model.
 *   2. IT ALWAYS EXITS. Claude waits on this process, so a stdin that never
 *      closes would stall a real session. A watchdog gives up after
 *      STDIN_TIMEOUT_MS and exits 0 with whatever arrived.
 *   3. IT PRINTS NOTHING ON STDOUT. Not the payload, not the outcome, not an
 *      error message. Diagnostics are opt-in on stderr via
 *      TANDEM_CLAUDE_HOOK_DEBUG and are a single outcome word.
 */
import {
  handleClaudeStopHook,
  hookDebugEnabled,
  MAX_HOOK_INPUT_BYTES,
} from "../bridge/claude-stop-hook.ts";

/**
 * Node prints its own ExperimentalWarnings to stderr — `node:sqlite` still
 * carries one on the Node 22 line, and the lifecycle store loads it. Today
 * nothing appears, but only because `process.emitWarning` defers printing to
 * the next tick and `finish()` calls `process.exit(0)` before that tick runs.
 * That is a race, not a promise, and a hook that whispers interpreter notes
 * into a user's session mid-turn is exactly what "silent by design" above
 * rules out. Dropping Node's default warning listener makes the silence
 * deliberate; it suppresses nothing this file itself chooses to write, and it
 * is scoped to this hook process alone — the bridge still surfaces its own.
 */
process.removeAllListeners("warning");

/** Claude is blocked on this process; give stdin a hard ceiling. */
const STDIN_TIMEOUT_MS = 5000;

/**
 * Read stdin up to the byte ceiling. Stops early once the ceiling is passed —
 * the payload is already unusable at that point, and continuing to buffer a
 * runaway producer would trade one lost record for a memory problem.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  process.stdin.on("error", () => {
    /* a closed or absent stdin is an empty payload, not a failure */
  });
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    total += buffer.byteLength;
    if (total > MAX_HOOK_INPUT_BYTES) return "";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function finish(outcome: string): never {
  if (hookDebugEnabled()) {
    // Outcome word only: this process knows a session identity and a fragment
    // of assistant output, and neither belongs on any stream.
    try {
      process.stderr.write(`[tandem-claude-hook] ${outcome}\n`);
    } catch {
      /* a closed stderr must not become a failed hook */
    }
  }
  process.exit(0);
}

async function main(): Promise<void> {
  // Fires only if stdin never ends; unref'd so it never keeps an otherwise
  // finished process alive.
  const watchdog = setTimeout(() => finish("timeout"), STDIN_TIMEOUT_MS);
  watchdog.unref();

  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    raw = "";
  }
  clearTimeout(watchdog);

  finish(handleClaudeStopHook(raw).outcome);
}

try {
  await main();
} catch {
  finish("error");
}
