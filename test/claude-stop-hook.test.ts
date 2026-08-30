import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeLifecycleStore, MAX_MESSAGE_CHARS } from "../bridge/claude-lifecycle-store.ts";
import { handleClaudeStopHook, MAX_HOOK_INPUT_BYTES } from "../bridge/claude-stop-hook.ts";

/**
 * The hook runs inside a real user's Claude session, which is blocked on it.
 * Every test here is ultimately about one property: whatever the payload, the
 * hook exits 0, prints nothing, and never throws. The recording is the part
 * that is allowed to fail.
 */

const roots: string[] = [];
function freshStore(): { store: ClaudeLifecycleStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tandem-claude-hook-"));
  roots.push(dir);
  return { store: new ClaudeLifecycleStore(dir), dir };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TANDEM_SESSION = "tandem-7f3a91c4";
const ENV = { TANDEM_SESSION_ID: TANDEM_SESSION };
const CLAUDE_SESSION = "8e1c0b2a-4d55-4f0e-9a11-2b6d7c8e9f01";

/** A payload shaped like the one Claude actually writes to the hook's stdin. */
function stopPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: CLAUDE_SESSION,
    transcript_path: "/Users/peter/.claude/projects/tooling-tandem/8e1c0b2a.jsonl",
    cwd: "/Users/peter/Developer/tooling/tandem",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Implemented the store and ran the tests.",
    ...overrides,
  });
}

describe("Stop", () => {
  it("records the turn with Claude's session id and the assistant message", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(stopPayload(), { store, env: ENV });
    expect(result).toMatchObject({ exitCode: 0, stdout: "", outcome: "recorded" });
    expect(result.event).toMatchObject({
      kind: "stop",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      message: "Implemented the store and ran the tests.",
    });
  });

  it("records a Stop that carries no assistant message", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(stopPayload({ last_assistant_message: undefined }), { store, env: ENV });
    expect(result.outcome).toBe("recorded");
    expect(result.event!.message).toBeUndefined();
  });

  it("ignores stop_hook_active, which guards a block this hook never performs", () => {
    const { store } = freshStore();
    expect(handleClaudeStopHook(stopPayload({ stop_hook_active: true }), { store, env: ENV }).outcome).toBe("recorded");
  });
});

describe("StopFailure", () => {
  it("records the failure boundary distinctly from a clean stop", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(
      JSON.stringify({
        session_id: CLAUDE_SESSION,
        transcript_path: "/Users/peter/.claude/projects/x.jsonl",
        cwd: "/Users/peter/Developer/tooling/tandem",
        hook_event_name: "StopFailure",
      }),
      { store, env: ENV },
    );
    expect(result.outcome).toBe("recorded");
    expect(result.event!.kind).toBe("stop_failure");
  });

  it("does not invent a message for a failure that has none", () => {
    const { store } = freshStore();
    // Even if a field of that name turned up, StopFailure text is not read.
    const result = handleClaudeStopHook(
      JSON.stringify({ session_id: CLAUDE_SESSION, hook_event_name: "StopFailure", last_assistant_message: "leftover" }),
      { store, env: ENV },
    );
    expect(result.event!.message).toBeUndefined();
  });
});

describe("UserPromptSubmit", () => {
  it("records the submit boundary, distinctly from Stop/StopFailure", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(
      JSON.stringify({
        session_id: CLAUDE_SESSION,
        transcript_path: "/Users/peter/.claude/projects/x.jsonl",
        cwd: "/Users/peter/Developer/tooling/tandem",
        hook_event_name: "UserPromptSubmit",
        prompt: "please fix the bug",
      }),
      { store, env: ENV },
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "", outcome: "recorded" });
    expect(result.event).toMatchObject({
      kind: "prompt_submit",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
    });
  });

  it("never reads or stores the prompt field", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(
      JSON.stringify({
        session_id: CLAUDE_SESSION,
        hook_event_name: "UserPromptSubmit",
        prompt: "this must never reach disk",
      }),
      { store, env: ENV },
    );
    expect(result.event!.message).toBeUndefined();
    expect(JSON.stringify(result.event)).not.toContain("this must never reach disk");
  });

  it("is not_tandem when there is no TANDEM_SESSION_ID, same as Stop", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(
      JSON.stringify({ session_id: CLAUDE_SESSION, hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      { store, env: {} },
    );
    expect(result.outcome).toBe("not_tandem");
  });
});

describe("malformed and foreign input", () => {
  const cases: Array<[string, string]> = [
    ["empty stdin", ""],
    ["whitespace only", "   \n  "],
    ["not JSON", "not json at all"],
    ["truncated JSON", '{"hook_event_name":"Stop"'],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", '"Stop"'],
    ["null", "null"],
    ["an object with no event name", '{"session_id":"abc"}'],
    ["a non-string event name", '{"hook_event_name":42,"session_id":"abc"}'],
    ["an event this hook is not for", '{"hook_event_name":"PreToolUse","session_id":"abc"}'],
    ["a prototype-pollution shaped event name", '{"hook_event_name":"constructor","session_id":"abc"}'],
    ["a future Claude event", '{"hook_event_name":"SessionEnd","session_id":"abc"}'],
  ];

  for (const [label, raw] of cases) {
    it(`ignores ${label} without throwing, printing, or failing`, () => {
      const { store } = freshStore();
      const result = handleClaudeStopHook(raw, { store, env: ENV });
      expect(result).toMatchObject({ exitCode: 0, stdout: "", outcome: "ignored" });
      expect(store.snapshot().seq).toBe(0);
    });
  }

  it("reports a Stop with an unusable session id as invalid rather than recording it", () => {
    const { store } = freshStore();
    for (const session of [undefined, "", 42, "has\nnewline", "x".repeat(200)]) {
      const result = handleClaudeStopHook(stopPayload({ session_id: session }), { store, env: ENV });
      expect(result).toMatchObject({ exitCode: 0, stdout: "", outcome: "invalid" });
    }
    expect(store.snapshot().seq).toBe(0);
  });

  it("does nothing for a Claude the user started outside Tandem", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(stopPayload(), { store, env: {} });
    expect(result).toMatchObject({ exitCode: 0, stdout: "", outcome: "not_tandem" });
    expect(store.snapshot().seq).toBe(0);
  });
});

describe("oversized input", () => {
  it("refuses to parse a payload past the input ceiling", () => {
    const { store } = freshStore();
    const huge = JSON.stringify({
      session_id: CLAUDE_SESSION,
      hook_event_name: "Stop",
      last_assistant_message: "x".repeat(MAX_HOOK_INPUT_BYTES + 1),
    });
    const result = handleClaudeStopHook(huge, { store, env: ENV });
    expect(result).toMatchObject({ exitCode: 0, stdout: "", outcome: "ignored" });
    expect(store.snapshot().seq).toBe(0);
  });

  it("records a large-but-acceptable message with the text clamped", () => {
    const { store } = freshStore();
    const result = handleClaudeStopHook(stopPayload({ last_assistant_message: "y".repeat(MAX_MESSAGE_CHARS * 10) }), {
      store,
      env: ENV,
    });
    expect(result.outcome).toBe("recorded");
    expect(result.event!.message!.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(result.event!.messageTruncated).toBe(true);
  });
});

describe("a store it cannot use", () => {
  it("reports unwritable instead of throwing when the state directory is blocked", () => {
    const { dir } = freshStore();
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "", { mode: 0o600 });
    const store = new ClaudeLifecycleStore(join(blocker, "sub"));
    const result = handleClaudeStopHook(stopPayload(), { store, env: ENV });
    expect(result).toMatchObject({ exitCode: 0, stdout: "", outcome: "unwritable" });
  });

  it("starts a clean store rather than failing when the existing one is corrupt", () => {
    const { store, dir } = freshStore();
    handleClaudeStopHook(stopPayload(), { store, env: ENV });
    writeFileSync(join(dir, "events.json"), "  garbage", { mode: 0o600 });
    expect(handleClaudeStopHook(stopPayload(), { store, env: ENV }).outcome).toBe("recorded");
  });

  it("starts a clean store rather than trusting one with loose permissions", () => {
    const { store, dir } = freshStore();
    handleClaudeStopHook(stopPayload(), { store, env: ENV });
    chmodSync(join(dir, "events.json"), 0o666);
    const result = handleClaudeStopHook(stopPayload(), { store, env: ENV });
    expect(result.outcome).toBe("recorded");
    // The untrusted history is discarded, not merged into.
    expect(result.event!.seq).toBe(1);
  });
});

describe("what the hook never leaks", () => {
  it("keeps the cwd and the transcript path out of the stored record", () => {
    const { store, dir } = freshStore();
    handleClaudeStopHook(stopPayload({ last_assistant_message: "finished work in /Users/peter/Developer/tooling/tandem" }), {
      store,
      env: ENV,
    });
    const raw = readFileSync(join(dir, "events.json"), "utf8");
    expect(raw).not.toContain("/Users/peter/Developer/tooling/tandem");
    expect(raw).not.toContain(".jsonl");
    expect(raw).not.toContain("transcript");
  });

  it("returns an empty stdout on every outcome", () => {
    const { store } = freshStore();
    const payloads = [stopPayload(), "not json", "", '{"hook_event_name":"PreToolUse"}', stopPayload({ session_id: "" })];
    for (const raw of payloads) {
      const result = handleClaudeStopHook(raw, { store, env: ENV });
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });
});

describe("the command entrypoint", () => {
  const entrypoint = fileURLToPath(new URL("../src/claude-stop-hook.ts", import.meta.url));

  /** Run the real hook process the way Claude would: payload on stdin. */
  function runHook(stdin: string, env: NodeJS.ProcessEnv): string {
    // execFileSync THROWS on a non-zero exit, so every call site that reaches
    // its assertion has already asserted "exit code 0".
    return execFileSync(process.execPath, ["--experimental-strip-types", entrypoint], {
      input: stdin,
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
  }

  function freshStateRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "tandem-claude-hook-cli-"));
    roots.push(dir);
    return dir;
  }

  it("exits 0, prints nothing, and records the turn for a real Stop payload", () => {
    const dir = freshStateRoot();
    expect(runHook(stopPayload(), { TANDEM_STATE_DIR: dir, TANDEM_SESSION_ID: TANDEM_SESSION })).toBe("");
    const page = new ClaudeLifecycleStore(join(dir, "claude-lifecycle")).readAfter(0);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ kind: "stop", tandemSession: TANDEM_SESSION });
  });

  it("exits 0 and prints nothing for garbage on stdin", () => {
    const dir = freshStateRoot();
    expect(runHook("}{ not json", { TANDEM_STATE_DIR: dir, TANDEM_SESSION_ID: TANDEM_SESSION })).toBe("");
    expect(new ClaudeLifecycleStore(join(dir, "claude-lifecycle")).snapshot().seq).toBe(0);
  });

  it("exits 0 and prints nothing when stdin is empty and no identity is set", () => {
    expect(runHook("", { TANDEM_STATE_DIR: freshStateRoot() })).toBe("");
  });

  it("prints the outcome word, and nothing sensitive, when debugging is turned on", () => {
    const dir = freshStateRoot();
    const run = spawnSync(process.execPath, ["--experimental-strip-types", entrypoint], {
      input: stopPayload(),
      encoding: "utf8",
      timeout: 30000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TANDEM_STATE_DIR: dir,
        TANDEM_SESSION_ID: TANDEM_SESSION,
        TANDEM_CLAUDE_HOOK_DEBUG: "1",
      },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim()).toBe("[tandem-claude-hook] recorded");
    // The outcome word is all it may say: no identity, no assistant text, no path.
    expect(run.stderr).not.toContain(TANDEM_SESSION);
    expect(run.stderr).not.toContain(CLAUDE_SESSION);
    expect(run.stderr).not.toContain("Implemented the store");
    expect(run.stderr).not.toContain("/Users/peter");
  });

  it("stays silent on stderr when debugging is off", () => {
    const dir = freshStateRoot();
    const run = spawnSync(process.execPath, ["--experimental-strip-types", entrypoint], {
      input: stopPayload(),
      encoding: "utf8",
      timeout: 30000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TANDEM_STATE_DIR: dir, TANDEM_SESSION_ID: TANDEM_SESSION },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});
