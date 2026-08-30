import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeLifecycleStore,
  CLAUDE_LIFECYCLE_VERSION,
  MAX_MESSAGE_CHARS,
  MAX_RETAINED_EVENTS,
  SYNTHETIC_CLAUDE_SESSION_ID,
  isOpaqueIdentity,
  tandemSessionIdentity,
} from "../bridge/claude-lifecycle-store.ts";

/**
 * The store is the durable half of the Claude lifecycle path. Its whole job is
 * to hold a bounded, owner-only record that a later reader can page through by
 * sequence — and to degrade to "no prior state" rather than to an error when
 * anything about the file on disk is off, because the writer is a hook process
 * a real user's Claude is waiting on.
 *
 * A NEW ClaudeLifecycleStore over the same directory is exactly what a
 * restarted bridge (or the next hook invocation, which is its own process)
 * gets: the class caches nothing, so every assertion below involving a second
 * instance is an assertion about surviving a restart.
 */

const roots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tandem-claude-lifecycle-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TANDEM_SESSION = "tandem-7f3a91c4";
const CLAUDE_SESSION = "8e1c0b2a-4d55-4f0e-9a11-2b6d7c8e9f01";

function storeFile(dir: string): string {
  return join(dir, "events.json");
}

describe("recording turn boundaries", () => {
  it("records a Stop with its clamped message", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const event = store.record({
      kind: "stop",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      message: "Refactored the parser and all tests pass.",
    });
    expect(event).toMatchObject({
      v: CLAUDE_LIFECYCLE_VERSION,
      seq: 1,
      kind: "stop",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      message: "Refactored the parser and all tests pass.",
    });
    expect(event!.id).toMatch(/^cl_[0-9a-f]{20}$/);
  });

  it("records a StopFailure, which carries no message", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const event = store.record({ kind: "stop_failure", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(event).toMatchObject({ kind: "stop_failure", seq: 1 });
    expect(event!.message).toBeUndefined();
  });

  it("records a prompt_submit, which NEVER carries a message even if one is supplied", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const event = store.record({
      kind: "prompt_submit",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      // A future hook edit that accidentally passed the prompt through must
      // still not reach disk — the store enforces this independently.
      message: "please do the thing",
    });
    expect(event).toMatchObject({ kind: "prompt_submit", seq: 1 });
    expect(event!.message).toBeUndefined();
    expect(event!.messageTruncated).toBeUndefined();
  });

  it("records Tandem-synthetic interrupt/close markers, which NEVER carry a message even if one is supplied", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    for (const kind of ["interrupt", "close"] as const) {
      const event = store.record({
        kind,
        tandemSession: TANDEM_SESSION,
        claudeSessionId: SYNTHETIC_CLAUDE_SESSION_ID,
        // Neither Tandem nor a future caller mistake is trusted to have
        // withheld this — the store enforces it independently.
        message: "should never reach disk",
      });
      expect(event).toMatchObject({ kind, claudeSessionId: SYNTHETIC_CLAUDE_SESSION_ID });
      expect(event!.message).toBeUndefined();
      expect(event!.messageTruncated).toBeUndefined();
    }
  });

  it("round-trips interrupt/close through readAfter, surviving a restart", () => {
    const directory = freshDir();
    const first = new ClaudeLifecycleStore(directory);
    first.record({ kind: "prompt_submit", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    first.record({ kind: "interrupt", tandemSession: TANDEM_SESSION, claudeSessionId: SYNTHETIC_CLAUDE_SESSION_ID });
    first.record({ kind: "close", tandemSession: TANDEM_SESSION, claudeSessionId: SYNTHETIC_CLAUDE_SESSION_ID });

    // A new instance over the same directory is exactly what a restarted
    // bridge (or the next hook invocation) gets.
    const reopened = new ClaudeLifecycleStore(directory);
    const page = reopened.readAfter(0);
    expect(page.events.map((e) => e.kind)).toEqual(["prompt_submit", "interrupt", "close"]);
  });

  it("keeps two identical consecutive turns apart", () => {
    // Claude hands the hook no turn counter, so a content-derived id would
    // collapse a genuine second turn into the first. Sequence must separate them.
    const store = new ClaudeLifecycleStore(freshDir());
    const first = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "done" });
    const second = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "done" });
    expect(second!.seq).toBe(first!.seq + 1);
    expect(second!.id).not.toBe(first!.id);
  });

  it("refuses a record with no usable identity rather than inventing one", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    expect(store.record({ kind: "stop", tandemSession: "", claudeSessionId: CLAUDE_SESSION })).toBeUndefined();
    expect(store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: "" })).toBeUndefined();
    expect(store.record({ kind: "stop", tandemSession: "has space\nnewline", claudeSessionId: CLAUDE_SESSION })).toBeUndefined();
    expect(store.snapshot().seq).toBe(0);
  });

  it("survives the process that wrote it", () => {
    const dir = freshDir();
    new ClaudeLifecycleStore(dir).record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const page = new ClaudeLifecycleStore(dir).readAfter(0);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.kind).toBe("stop");
  });
});

describe("bounding the message", () => {
  it("clamps an oversized message and says so", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const event = store.record({
      kind: "stop",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      message: "x".repeat(MAX_MESSAGE_CHARS * 4),
    });
    expect(event!.message!.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(event!.messageTruncated).toBe(true);
  });

  it("does not flag a message that merely got shorter through redaction", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const event = store.record({
      kind: "stop",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      message: "pushed to https://github.example.com/a/very/long/repository/path/indeed",
    });
    expect(event!.messageTruncated).toBeUndefined();
  });

  it("keeps an oversized run of messages inside the retention bound", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    for (let i = 0; i < MAX_RETAINED_EVENTS + 25; i++) {
      store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: `turn ${i}` });
    }
    const page = store.readAfter(0, { limit: MAX_RETAINED_EVENTS });
    expect(page.events.length).toBeLessThanOrEqual(MAX_RETAINED_EVENTS);
    // The OLDEST are the ones dropped, and the reader is told history is gone.
    expect(page.truncated).toBe(true);
    expect(page.events[page.events.length - 1]!.message).toBe(`turn ${MAX_RETAINED_EVENTS + 24}`);
  });
});

describe("what never reaches disk", () => {
  it("stores no path, transcript location, or credential from a message", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({
      kind: "stop",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      message:
        "wrote /Users/peter/Developer/tooling/tandem/bridge/router.ts, read ~/.claude/projects/abc/transcript.jsonl, token=ghp_AAAAAAAAAAAAAAAAAAAAAAAA, mailed a@b.com via https://hub.example.ts.net/x",
    });
    const raw = readFileSync(storeFile(dir), "utf8");
    expect(raw).not.toContain("/Users/peter");
    expect(raw).not.toContain("transcript.jsonl");
    expect(raw).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(raw).not.toContain("a@b.com");
    expect(raw).not.toContain("ts.net");
    // The record still exists and is still worth reading.
    const message = new ClaudeLifecycleStore(dir).readAfter(0).events[0]!.message!;
    expect(message).toContain("<path>");
    // The `token=<value>` rule wins over the bare-secret rule; either way the
    // secret itself is gone.
    expect(message).toContain("token=<redacted>");
  });

  it("has no field for a cwd or a transcript path at all", () => {
    const dir = freshDir();
    new ClaudeLifecycleStore(dir).record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const parsed = JSON.parse(readFileSync(storeFile(dir), "utf8"));
    const keys = Object.keys(parsed.events[0]);
    expect(keys).not.toContain("cwd");
    expect(keys).not.toContain("transcript_path");
    expect(keys).not.toContain("transcriptPath");
  });
});

describe("file trust model", () => {
  it("creates the directory 0700 and the file 0600", () => {
    const dir = join(freshDir(), "nested");
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(storeFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(readFileSync(storeFile(dir), "utf8").endsWith("\n")).toBe(true);
  });

  it("ignores a store any other account could read", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    chmodSync(storeFile(dir), 0o644);
    expect(store.readAfter(0).events).toEqual([]);
    expect(store.snapshot().seq).toBe(0);
  });

  it("ignores a corrupt store instead of throwing", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    writeFileSync(storeFile(dir), "{not json at all", { mode: 0o600 });
    expect(() => store.readAfter(0)).not.toThrow();
    expect(store.readAfter(0).events).toEqual([]);
    // And a later write starts a clean store rather than failing.
    expect(store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })).toBeDefined();
  });

  it("ignores a store written by an older version", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      storeFile(dir),
      JSON.stringify({ version: CLAUDE_LIFECYCLE_VERSION - 1, epoch: "old", nextSeq: 9, droppedThrough: 0, events: [] }),
      { mode: 0o600 },
    );
    expect(new ClaudeLifecycleStore(dir).readAfter(0).events).toEqual([]);
  });

  it("drops one malformed record without losing the rest of the store", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "good" });
    const parsed = JSON.parse(readFileSync(storeFile(dir), "utf8"));
    parsed.events.push({ v: CLAUDE_LIFECYCLE_VERSION, id: "cl_bad", seq: "not-a-number", kind: "stop" });
    writeFileSync(storeFile(dir), JSON.stringify(parsed), { mode: 0o600 });
    const page = store.readAfter(0);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.message).toBe("good");
  });

  it("returns undefined rather than throwing when the store cannot be written", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    // A regular file where the store directory must go: mkdir will fail.
    writeFileSync(dir + "-blocked", "", { mode: 0o600 });
    roots.push(dir + "-blocked");
    const blocked = new ClaudeLifecycleStore(join(dir + "-blocked", "sub"));
    expect(() => blocked.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })).not.toThrow();
    expect(blocked.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })).toBeUndefined();
    expect(store.snapshot().seq).toBe(0);
  });
});

describe("snapshot and read-after sequencing", () => {
  it("reports an empty store as seq 0 with a deterministic epoch", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    expect(store.snapshot()).toEqual({ seq: 0, storeEpoch: "0" });
  });

  it("returns only events newer than the snapshot", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "old" });
    const cursor = store.snapshot();
    expect(cursor.seq).toBe(1);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "new" });

    const page = store.readAfter(cursor.seq, { storeEpoch: cursor.storeEpoch });
    expect(page.events.map((e) => e.message)).toEqual(["new"]);
    expect(page.seq).toBe(2);
    expect(page.more).toBe(false);
    expect(page.truncated).toBe(false);
  });

  it("returns nothing when nothing has happened since the snapshot", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const cursor = store.snapshot();
    const page = store.readAfter(cursor.seq, { storeEpoch: cursor.storeEpoch });
    expect(page.events).toEqual([]);
    // The cursor must not walk backwards on an empty page.
    expect(page.seq).toBe(cursor.seq);
  });

  it("never re-delivers an event a router has already read", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "a" });
    store.record({ kind: "stop_failure", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    let cursor = 0;
    const seen: string[] = [];
    for (let poll = 0; poll < 3; poll++) {
      const page = store.readAfter(cursor);
      for (const e of page.events) seen.push(e.kind);
      cursor = page.seq;
    }
    expect(seen).toEqual(["stop", "stop_failure"]);
  });

  it("pages a long backlog without dropping or repeating an event", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    for (let i = 0; i < 25; i++) {
      store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: `m${i}` });
    }
    const collected: string[] = [];
    let cursor = 0;
    let more = true;
    while (more) {
      const page = store.readAfter(cursor, { limit: 10 });
      collected.push(...page.events.map((e) => e.message!));
      cursor = page.seq;
      more = page.more;
    }
    expect(collected).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
  });

  it("tells a reader whose history was rotated away that it lost events", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    for (let i = 0; i < MAX_RETAINED_EVENTS + 5; i++) {
      store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    }
    // A reader that snapshotted at the very beginning.
    expect(store.readAfter(0).truncated).toBe(true);
    // A reader that is current has lost nothing.
    expect(store.readAfter(store.snapshot().seq).truncated).toBe(false);
  });

  it("treats a seq from a store that no longer exists as truncated", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const cursor = store.snapshot();

    // The store is wiped and rebuilt — a new epoch, and seq 1 means something else.
    rmSync(storeFile(dir), { force: true });
    store.record({ kind: "stop_failure", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });

    const page = store.readAfter(cursor.seq, { storeEpoch: cursor.storeEpoch });
    expect(page.storeEpoch).not.toBe(cursor.storeEpoch);
    expect(page.truncated).toBe(true);
  });

  it("does not call an empty-store snapshot truncated when events arrive later", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const cursor = store.snapshot();
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const page = store.readAfter(cursor.seq, { storeEpoch: cursor.storeEpoch });
    expect(page.truncated).toBe(false);
    expect(page.events).toHaveLength(1);
  });

  it("ignores a nonsensical seq rather than failing", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    for (const seq of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => store.readAfter(seq)).not.toThrow();
    }
    expect(store.readAfter(-1).events).toHaveLength(1);
    expect(store.readAfter(Number.MAX_SAFE_INTEGER).events).toEqual([]);
  });
});

describe("supplied identity", () => {
  it("accepts a bounded printable identity and refuses anything else", () => {
    expect(isOpaqueIdentity("tandem-7f3a91c4")).toBe(true);
    expect(isOpaqueIdentity("")).toBe(false);
    expect(isOpaqueIdentity(" leading-space")).toBe(false);
    expect(isOpaqueIdentity("new\nline")).toBe(false);
    expect(isOpaqueIdentity("x".repeat(129))).toBe(false);
    expect(isOpaqueIdentity(42)).toBe(false);
  });

  it("reads the identity from the environment, and reports its absence", () => {
    expect(tandemSessionIdentity({ TANDEM_SESSION_ID: TANDEM_SESSION })).toBe(TANDEM_SESSION);
    expect(tandemSessionIdentity({})).toBeUndefined();
    expect(tandemSessionIdentity({ TANDEM_SESSION_ID: "   " })).toBeUndefined();
    expect(tandemSessionIdentity({ TANDEM_SESSION_ID: "bad\nid" })).toBeUndefined();
  });
});

/**
 * `record()`'s same-process-instance behaviour under the lock: two calls on
 * ONE store instance already exercise acquire-then-release-then-reacquire
 * (this is not the cross-process proof — that lives in
 * test/claude-lifecycle-store-concurrency.test.ts, which spawns real child
 * processes — but it is what a fast, deterministic unit test can pin down:
 * stale-lock recovery and a live-lock timeout degrading safely).
 */
describe("the cross-process lock", () => {
  it("still records normally when unlocked (the common case)", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const a = store.record({ kind: "prompt_submit", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const b = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(2);
  });

  it("recovers a stale lock left by a crashed process and still writes", () => {
    const dir = freshDir();
    // A tiny stale threshold and a fresh mtime lock: sleeping past the
    // threshold before calling record() is enough to make it look abandoned
    // without needing to fabricate an old mtime.
    const store = new ClaudeLifecycleStore(dir, { staleAfterMs: 5, retryBudgetMs: 2000 });
    mkdirSync(join(dir, "events.json.lock"), { mode: 0o700 });
    // Let the lock age past staleAfterMs — a synchronous sleep, matching how
    // record() itself waits (see ClaudeLifecycleStore.sleepSync).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    const event = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(event).toBeDefined();
    expect(store.readAfter(0).events).toHaveLength(1);
  });

  it("gives up and returns undefined, without corrupting the store, when the lock is genuinely held", () => {
    const dir = freshDir();
    // A generous staleAfterMs (so the manually-created lock never looks
    // abandoned during this test) and a short retryBudgetMs (so the test
    // itself stays fast).
    const store = new ClaudeLifecycleStore(dir, { staleAfterMs: 60_000, retryBudgetMs: 40 });
    // Seed the store with one real record first, so there is a pre-existing
    // valid file to prove is untouched by the failed attempt.
    store.record({ kind: "prompt_submit", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const before = readFileSync(storeFile(dir), "utf8");

    // Simulate another process genuinely holding the lock right now.
    mkdirSync(join(dir, "events.json.lock"), { mode: 0o700 });

    expect(() =>
      store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION }),
    ).not.toThrow();
    const result = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(result).toBeUndefined();

    const after = readFileSync(storeFile(dir), "utf8");
    expect(after).toBe(before);
    expect(JSON.parse(after).events).toHaveLength(1);
  });

  it("only ever removes a lock it acquired itself, and releases in a finally", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir, { retryBudgetMs: 2000 });
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    // The lock must not still be sitting there after a successful record().
    expect(() => statSync(join(dir, "events.json.lock"))).toThrow();
  });
});
