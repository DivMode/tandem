import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeLifecycleStore } from "../bridge/claude-lifecycle-store.ts";

/**
 * TRUE cross-process concurrency, not same-process interleaving. Every
 * Tandem-spawned Claude worker's Stop/StopFailure/UserPromptSubmit hook is a
 * SEPARATE OS process, and every one of them writes into the SAME shared
 * lifecycle store file. This spawns the REAL hook entrypoint
 * (src/claude-stop-hook.ts) as real child processes, exactly the way Claude
 * itself invokes it, and proves record()'s lock (bridge/claude-lifecycle-
 * store.ts) actually serializes them instead of letting concurrent
 * load->persist races silently discard records.
 *
 * PRE-FIX MEASUREMENT (reported by an independent review, reproduced by
 * hand before this lock existed): 150 concurrent hook processes each writing
 * one record -> only ~32 survived. The "no lost writes" test below is the
 * same shape of load, run for real against the fixed store.
 */

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
 *  is what makes this a genuine cross-process concurrency test. */
function runHookAsync(stdin: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))));
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

describe("cross-process concurrency (real child processes, real lock)", () => {
  it("loses nothing under contention: 150 concurrent hook processes across 15 sessions all survive with unique, monotonic seqs", async () => {
    const dir = freshStateRoot();
    const SESSIONS = Array.from({ length: 15 }, (_, i) => `tandem-conc-${i.toString().padStart(2, "0")}`);
    const PER_SESSION = 10; // 15 * 10 = 150, matching the reported reproduction scale.

    const runs: Promise<void>[] = [];
    for (const session of SESSIONS) {
      for (let i = 0; i < PER_SESSION; i += 1) {
        const payload = i % 2 === 0 ? submitPayload("claude-session-id") : stopPayload("claude-session-id", `msg ${i}`);
        runs.push(runHookAsync(payload, { TANDEM_STATE_DIR: dir, TANDEM_SESSION_ID: session }));
      }
    }
    await Promise.all(runs);

    const { events } = loadStore(dir);
    expect(events).toHaveLength(150);

    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(150); // every seq unique
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted[0]).toBe(1);
    expect(sorted[sorted.length - 1]).toBe(150); // monotonic 1..150, no gaps at all
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]).toBe(sorted[i - 1] + 1);
  }, 30_000);

  it("preserves same-session prompt_submit -> stop ordering even while unrelated sessions hammer the same store concurrently", async () => {
    const dir = freshStateRoot();
    const orderedSession = "tandem-ordering-check";
    const noise: Promise<void>[] = [];
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
    // 40 unrelated noise writers above are racing the lock concurrently.
    await runHookAsync(submitPayload("claude-session-id"), {
      TANDEM_STATE_DIR: dir,
      TANDEM_SESSION_ID: orderedSession,
    });
    await runHookAsync(stopPayload("claude-session-id", "the ordered turn's own message"), {
      TANDEM_STATE_DIR: dir,
      TANDEM_SESSION_ID: orderedSession,
    });

    await Promise.all(noise);

    const { events } = loadStore(dir);
    const own = events.filter((e) => e.tandemSession === orderedSession).sort((a, b) => a.seq - b.seq);
    expect(own.map((e) => e.kind)).toEqual(["prompt_submit", "stop"]);
    expect(own[1]!.seq).toBeGreaterThan(own[0]!.seq);
  }, 30_000);
});
