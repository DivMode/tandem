import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeLifecycleStore } from "../bridge/claude-lifecycle-store.ts";

/**
 * TRUE cross-process concurrency, not same-process interleaving. Every
 * Tandem-spawned Claude worker's Stop/StopFailure/UserPromptSubmit hook is a
 * SEPARATE OS process, and every one of them writes into the SAME shared
 * lifecycle store. This spawns the REAL hook entrypoint
 * (src/claude-stop-hook.ts) as real child processes, exactly the way Claude
 * itself invokes it, and proves the store (bridge/claude-lifecycle-store.ts)
 * actually serializes them instead of letting concurrent read->write races
 * silently discard records.
 *
 * PRE-FIX MEASUREMENT (reported by an independent review, reproduced by hand
 * against the original JSON-file implementation): 150 concurrent hook
 * processes each writing one record -> only ~32 survived. The "no lost writes"
 * test below is the same shape of load, run for real against the store as it
 * is now.
 *
 * THIS TEST CANNOT PASS ON A STORE THAT REFUSES WRITES. The hook always exits
 * 0 — that is its whole contract — so an exit code proves nothing about
 * whether anything was recorded. Every child therefore runs with
 * TANDEM_CLAUDE_HOOK_DEBUG=1, which makes it print its one-word outcome to
 * stderr, and every outcome is asserted to be `recorded`. A store that
 * silently returned `unwritable` for all 150 would fail here on the outcomes
 * before it ever reached the sequence assertions.
 */

/** Exactly the flags bin/tandem-claude-stop-hook.mjs passes when it re-execs
 *  this entrypoint. `--no-warnings` is part of that command, not a convenience
 *  for the assertions: on a Node whose type stripping is still experimental,
 *  the interpreter would otherwise write its own notice to the stderr these
 *  tests are asserting about, and production would never see it. */
const HOOK_NODE_ARGS = ["--experimental-strip-types", "--no-warnings"];

const entrypoint = fileURLToPath(new URL("../src/claude-stop-hook.ts", import.meta.url));

const roots: string[] = [];
function freshStateRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "tandem-claude-hook-concurrency-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run one real hook process asynchronously — many of these in flight at once
 *  is what makes this a genuine cross-process concurrency test. Resolves with
 *  the hook's own reported outcome word. */
function runHookAsync(stdin: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...HOOK_NODE_ARGS, entrypoint], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TANDEM_CLAUDE_HOOK_DEBUG: "1",
        ...env,
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}`));
      const outcome = /\[tandem-claude-hook\] (\w+)/.exec(stderr)?.[1];
      resolve(outcome ?? `no-outcome(${JSON.stringify(stderr)})`);
    });
    child.stdin.end(stdin);
  });
}

function submitPayload(sessionId: string): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "UserPromptSubmit",
    prompt: "do the thing",
  });
}

function stopPayload(sessionId: string, message: string): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: message,
  });
}

function loadStore(dir: string): { events: Array<{ seq: number; kind: string; tandemSession: string }> } {
  const page = new ClaudeLifecycleStore(join(dir, "claude-lifecycle")).readAfter(0, { limit: 200 });
  return { events: page.events };
}

describe("cross-process concurrency (real child processes, real SQLite transactions)", () => {
  it("loses nothing under contention: 150 concurrent hook processes across 15 sessions all survive with unique, monotonic seqs", async () => {
    const dir = freshStateRoot();
    const SESSIONS = Array.from({ length: 15 }, (_, i) => `tandem-conc-${i.toString().padStart(2, "0")}`);
    const PER_SESSION = 10; // 15 * 10 = 150, matching the reported reproduction scale.

    const runs: Promise<string>[] = [];
    for (const session of SESSIONS) {
      for (let i = 0; i < PER_SESSION; i += 1) {
        const payload = i % 2 === 0 ? submitPayload("claude-session-id") : stopPayload("claude-session-id", `msg ${i}`);
        runs.push(runHookAsync(payload, { TANDEM_STATE_DIR: dir, TANDEM_SESSION_ID: session }));
      }
    }
    const outcomes = await Promise.all(runs);

    // Every single hook must say it recorded. Without this, a store that
    // refused every write would still exit 0 one hundred and fifty times.
    expect(outcomes).toHaveLength(150);
    expect(new Set(outcomes)).toEqual(new Set(["recorded"]));

    const { events } = loadStore(dir);
    expect(events).toHaveLength(150);

    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(150); // every seq unique
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted[0]).toBe(1);
    expect(sorted[sorted.length - 1]).toBe(150); // monotonic 1..150, no gaps at all
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]).toBe(sorted[i - 1] + 1);
  }, 60_000);

  it("preserves same-session prompt_submit -> stop ordering even while unrelated sessions hammer the same store concurrently", async () => {
    const dir = freshStateRoot();
    const orderedSession = "tandem-ordering-check";
    const noise: Promise<string>[] = [];
    for (let i = 0; i < 40; i += 1) {
      noise.push(
        runHookAsync(i % 2 === 0 ? submitPayload("claude-session-id") : stopPayload("claude-session-id", "noise"), {
          TANDEM_STATE_DIR: dir,
          TANDEM_SESSION_ID: `tandem-noise-${i % 5}`,
        }),
      );
    }

    // This session's own submit, then (once it has actually landed) its own
    // stop — the two calls are sequenced relative to EACH OTHER, while the
    // 40 unrelated noise writers above are racing for the same write lock.
    expect(
      await runHookAsync(submitPayload("claude-session-id"), {
        TANDEM_STATE_DIR: dir,
        TANDEM_SESSION_ID: orderedSession,
      }),
    ).toBe("recorded");
    expect(
      await runHookAsync(stopPayload("claude-session-id", "the ordered turn's own message"), {
        TANDEM_STATE_DIR: dir,
        TANDEM_SESSION_ID: orderedSession,
      }),
    ).toBe("recorded");

    expect(new Set(await Promise.all(noise))).toEqual(new Set(["recorded"]));

    const { events } = loadStore(dir);
    const own = events.filter((e) => e.tandemSession === orderedSession).sort((a, b) => a.seq - b.seq);
    expect(own.map((e) => e.kind)).toEqual(["prompt_submit", "stop"]);
    expect(own[1]!.seq).toBeGreaterThan(own[0]!.seq);
  }, 60_000);

  it("a writer killed mid-transaction wedges nothing: the next hook rolls its journal back and records normally", async () => {
    // This is the property the old hand-rolled lock needed a wall-clock
    // staleness heuristic to approximate. SQLite gets it exactly: the killed
    // process leaves a hot journal, and the NEXT process to open the database
    // rolls it back — no timeout, no guess about whether the holder is dead.
    const dir = freshStateRoot();
    const dbPath = join(dir, "claude-lifecycle", "events.db");

    expect(
      await runHookAsync(stopPayload("claude-session-id", "first"), {
        TANDEM_STATE_DIR: dir,
        TANDEM_SESSION_ID: "tandem-survivor",
      }),
    ).toBe("recorded");

    // A child that takes the write lock, writes, and then never commits.
    const script = join(dir, "hold-and-die.mjs");
    writeFileSync(
      script,
      [
        "import { DatabaseSync } from 'node:sqlite'",
        "const db = new DatabaseSync(process.argv[2])",
        "db.exec('BEGIN IMMEDIATE')",
        "db.prepare('INSERT INTO events (ts_ms, kind, tandem_session, claude_session_id) VALUES (?, ?, ?, ?)')",
        "  .run(Date.now(), 'stop', 'tandem-killed-writer', 'claude-session-id')",
        "process.stdout.write('held\\n')",
        "setInterval(() => {}, 1000)",
        "",
      ].join("\n"),
    );

    const holder = spawn(process.execPath, [script, dbPath], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => {
      holder.stdout.on("data", (chunk) => (String(chunk).includes("held") ? resolve() : undefined));
      holder.on("error", reject);
      holder.on("exit", () => reject(new Error("holder exited before taking the lock")));
    });

    // It really is mid-transaction: the rollback journal is on disk.
    expect(existsSync(`${dbPath}-journal`)).toBe(true);

    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.on("exit", () => resolve()));

    // The very next hook process must succeed — no stale-lock timeout to wait
    // out, and the killed writer's uncommitted row must not be there.
    expect(
      await runHookAsync(stopPayload("claude-session-id", "after the crash"), {
        TANDEM_STATE_DIR: dir,
        TANDEM_SESSION_ID: "tandem-survivor",
      }),
    ).toBe("recorded");

    const { events } = loadStore(dir);
    expect(events.map((e) => e.tandemSession)).toEqual(["tandem-survivor", "tandem-survivor"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  }, 60_000);
});
