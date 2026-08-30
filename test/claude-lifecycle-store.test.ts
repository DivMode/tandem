import { describe, it, expect, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
 * anything about the state on disk is off, because the writer is a hook process
 * a real user's Claude is waiting on.
 *
 * THESE TESTS ASSERT THE CONTRACT, NOT THE BACKING STORE. They go through
 * record/snapshot/readAfter, and where they must touch the file at all they
 * assert properties that hold of any backing format: the raw bytes on disk
 * carry no secret, the file is owner-only, a file that is not this store's is
 * refused. The three places that unavoidably know it is SQLite — fabricating a
 * store stamped with another version, inserting a row the schema permits but
 * the contract does not, and holding a real write lock from a second
 * connection — say so and say why.
 *
 * A NEW ClaudeLifecycleStore over the same directory is exactly what a
 * restarted bridge (or the next hook invocation, which is its own process)
 * gets: instances hold no state and no open handle, so every assertion below
 * involving a second instance is an assertion about surviving a restart.
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

/** The store's one file. Named here so the trust-model tests can corrupt,
 *  chmod and replace it; nothing asserts anything about its contents. */
function storeFile(dir: string): string {
  return join(dir, "events.db");
}

/** The raw bytes on disk, as text. Used only to prove that things which must
 *  never reach disk did not — an assertion that is format-independent. */
function rawStoreBytes(dir: string): string {
  return readFileSync(storeFile(dir), "latin1");
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

  it("returns exactly the event a later read returns", () => {
    // The id and ts are derived; the write path and the read path must not be
    // able to disagree about them.
    const dir = freshDir();
    const written = new ClaudeLifecycleStore(dir).record({
      kind: "stop",
      tandemSession: TANDEM_SESSION,
      claudeSessionId: CLAUDE_SESSION,
      message: "done",
    });
    const read = new ClaudeLifecycleStore(dir).readAfter(0).events[0];
    expect(read).toEqual(written);
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

  it("keeps issuing higher seqs across restarts, never restarting the sequence", () => {
    const dir = freshDir();
    const seqs: number[] = [];
    for (let restart = 0; restart < 5; restart++) {
      // A brand new instance each time: no cached handle, no cached counter.
      seqs.push(new ClaudeLifecycleStore(dir).record({
        kind: "stop",
        tandemSession: TANDEM_SESSION,
        claudeSessionId: CLAUDE_SESSION,
      })!.seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
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

describe("retention", () => {
  it("drops events past the age bound and tells a reader history went with them", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, now: tenDaysAgo });
    const fresh = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });

    const page = store.readAfter(0);
    expect(page.events.map((e) => e.seq)).toEqual([fresh!.seq]);
    expect(page.truncated).toBe(true);
  });

  it("never reissues a seq that retention has dropped", () => {
    // The bound is what makes this cheap to prove: write past it, then keep
    // writing, and check that nothing ever comes back round.
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    const issued: number[] = [];
    for (let i = 0; i < MAX_RETAINED_EVENTS + 50; i++) {
      issued.push(store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })!.seq);
    }
    expect(new Set(issued).size).toBe(issued.length);
    expect(issued).toEqual(issued.map((_, i) => i + 1));
    // And the store agrees about how far it has issued, even though only the
    // last MAX_RETAINED_EVENTS are still readable.
    expect(store.snapshot().seq).toBe(issued[issued.length - 1]);
    expect(store.readAfter(0, { limit: MAX_RETAINED_EVENTS }).events).toHaveLength(MAX_RETAINED_EVENTS);
  });

  it("keeps the file bounded across many writes", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    for (let i = 0; i < MAX_RETAINED_EVENTS * 3; i++) {
      store.record({
        kind: "stop",
        tandemSession: TANDEM_SESSION,
        claudeSessionId: CLAUDE_SESSION,
        message: "y".repeat(MAX_MESSAGE_CHARS),
      });
    }
    // 200 retained records of a 2000-char message is ~400KB of content; the
    // point is that it does not grow with the 600 writes that produced it.
    expect(statSync(storeFile(dir)).size).toBeLessThan(4 * 1024 * 1024);
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
    const raw = rawStoreBytes(dir);
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
    const event = new ClaudeLifecycleStore(dir).readAfter(0).events[0]!;
    const keys = Object.keys(event);
    expect(keys).not.toContain("cwd");
    expect(keys).not.toContain("transcript_path");
    expect(keys).not.toContain("transcriptPath");
    // And nothing resembling either name is anywhere in the stored bytes.
    const raw = rawStoreBytes(dir);
    expect(raw).not.toContain("transcript");
    expect(raw).not.toContain("cwd");
  });
});

describe("file trust model", () => {
  it("creates the directory 0700 and the store 0600", () => {
    const dir = join(freshDir(), "nested");
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(storeFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("leaves nothing behind but the store itself — no lock, no journal, no temp file", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    store.readAfter(0);
    expect(readdirSync(dir)).toEqual(["events.db"]);
  });

  it("keeps every sidecar it does create owner-only too", () => {
    // A rollback journal exists only while a transaction is open, so this
    // opens one deliberately — from a SECOND connection, the way a concurrent
    // hook process would — and checks what appears next to the store.
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });

    const other = new DatabaseSync(storeFile(dir));
    try {
      other.exec("BEGIN IMMEDIATE");
      other.prepare("INSERT INTO events (ts_ms, kind, tandem_session, claude_session_id) VALUES (?, ?, ?, ?)").run(
        Date.now(),
        "stop",
        TANDEM_SESSION,
        CLAUDE_SESSION,
      );
      const sidecars = readdirSync(dir).filter((name) => name !== "events.db");
      expect(sidecars.length).toBeGreaterThan(0);
      for (const name of sidecars) expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
      other.exec("ROLLBACK");
    } finally {
      other.close();
    }
  });

  it("ignores a store any other account could read", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    chmodSync(storeFile(dir), 0o644);
    expect(store.readAfter(0).events).toEqual([]);
    expect(store.snapshot().seq).toBe(0);
  });

  it("replaces a store any other account could read rather than appending to it", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    chmodSync(storeFile(dir), 0o644);

    const event = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    // The untrusted history is discarded, not merged into, and the replacement
    // is owner-only again.
    expect(event!.seq).toBe(1);
    expect(statSync(storeFile(dir)).mode & 0o777).toBe(0o600);
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

  it("ignores a store written by another version", () => {
    // Knows the backing store to FABRICATE the input; the assertion is the
    // contract — state stamped with a version this build does not write is
    // never read as if it were ours.
    const dir = freshDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const foreign = new DatabaseSync(storeFile(dir));
    foreign.exec(`PRAGMA user_version = ${CLAUDE_LIFECYCLE_VERSION + 1}`);
    foreign.exec("CREATE TABLE whatever_the_next_schema_looks_like (a TEXT)");
    foreign.close();
    chmodSync(storeFile(dir), 0o600);

    const store = new ClaudeLifecycleStore(dir);
    expect(store.readAfter(0).events).toEqual([]);
    expect(store.snapshot()).toEqual({ seq: 0, storeEpoch: "0" });
    // A write replaces it rather than failing forever against it.
    expect(store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })!.seq).toBe(1);
  });

  it("drops one malformed record without losing the rest of the store", () => {
    // Knows the backing store to WRITE the bad row. The schema's own CHECKs
    // stop most nonsense; this inserts something they permit but the contract
    // does not — an identity with a newline in it.
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "good" });

    const raw = new DatabaseSync(storeFile(dir));
    try {
      raw
        .prepare("INSERT INTO events (ts_ms, kind, tandem_session, claude_session_id) VALUES (?, ?, ?, ?)")
        .run(Date.now(), "stop", "smuggled\nnewline", CLAUDE_SESSION);
    } finally {
      raw.close();
    }

    const page = store.readAfter(0);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.message).toBe("good");
    // The refused row still moves the cursor, so a reader cannot be handed it
    // again for ever.
    expect(page.seq).toBe(2);
  });

  it("never follows a symlink at the store path when writing", () => {
    const dir = freshDir();
    const outside = join(dir, "someone-elses-file");
    writeFileSync(outside, "do not touch", { mode: 0o600 });
    mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(dir, "state", "events.db"));

    const store = new ClaudeLifecycleStore(join(dir, "state"));
    const event = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });

    // The target is untouched, the link is gone, and the store is a real file.
    expect(readFileSync(outside, "utf8")).toBe("do not touch");
    expect(lstatSync(join(dir, "state", "events.db")).isSymbolicLink()).toBe(false);
    expect(event!.seq).toBe(1);
    expect(store.readAfter(0).events).toHaveLength(1);
  });

  it("never follows a symlink at the store path when reading", () => {
    const dir = freshDir();
    const real = join(dir, "real");
    new ClaudeLifecycleStore(real).record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });

    mkdirSync(join(dir, "linked"), { recursive: true, mode: 0o700 });
    symlinkSync(storeFile(real), join(dir, "linked", "events.db"));

    const through = new ClaudeLifecycleStore(join(dir, "linked"));
    expect(through.readAfter(0).events).toEqual([]);
    expect(through.snapshot()).toEqual({ seq: 0, storeEpoch: "0" });
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
    expect(() => blocked.readAfter(0)).not.toThrow();
    expect(blocked.readAfter(0).events).toEqual([]);
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

  it("treats a seq from a store that was REPLACED by another as truncated", () => {
    // Not a delete: a whole different, perfectly valid store swapped in under
    // the same path, whose seq 1 is a different event entirely.
    const dir = freshDir();
    const elsewhere = freshDir();
    const store = new ClaudeLifecycleStore(dir);
    store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "mine" });
    const cursor = store.snapshot();

    const other = new ClaudeLifecycleStore(elsewhere);
    other.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION, message: "theirs" });
    writeFileSync(storeFile(dir), readFileSync(storeFile(elsewhere)), { mode: 0o600 });

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
 * There is no lock of Tandem's own any more — SQLite's own write lock is the
 * serialisation, and `busy_timeout` is the bound on waiting for it. These are
 * the fast, deterministic assertions about that bound. The cross-process proof
 * that it actually serialises real hook processes lives in
 * test/claude-lifecycle-store-concurrency.test.ts.
 */
describe("the bounded write lock", () => {
  it("records normally when uncontended (the common case)", () => {
    const store = new ClaudeLifecycleStore(freshDir());
    const a = store.record({ kind: "prompt_submit", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const b = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(2);
  });

  it("gives up and returns undefined, without corrupting the store, when the write lock is genuinely held", () => {
    const dir = freshDir();
    // A short busy timeout so the test stays fast; production is 3000ms.
    const store = new ClaudeLifecycleStore(dir, { busyTimeoutMs: 40 });
    // Seed the store with one real record first, so there is a pre-existing
    // valid store to prove is untouched by the failed attempt.
    store.record({ kind: "prompt_submit", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    const before = readFileSync(storeFile(dir));

    // A second connection holding the write lock is exactly what a concurrent
    // hook process looks like to this one.
    const holder = new DatabaseSync(storeFile(dir));
    try {
      holder.exec("BEGIN IMMEDIATE");
      holder.prepare("INSERT INTO events (ts_ms, kind, tandem_session, claude_session_id) VALUES (?, ?, ?, ?)").run(
        Date.now(),
        "stop",
        TANDEM_SESSION,
        CLAUDE_SESSION,
      );

      expect(() =>
        store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION }),
      ).not.toThrow();
      expect(store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })).toBeUndefined();

      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }

    expect(readFileSync(storeFile(dir)).equals(before)).toBe(true);
    expect(store.readAfter(0).events).toHaveLength(1);
  });

  it("gives up inside its budget rather than waiting indefinitely", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir, { busyTimeoutMs: 50 });
    store.record({ kind: "prompt_submit", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });

    const holder = new DatabaseSync(storeFile(dir));
    try {
      holder.exec("BEGIN IMMEDIATE");
      holder.prepare("INSERT INTO events (ts_ms, kind, tandem_session, claude_session_id) VALUES (?, ?, ?, ?)").run(
        Date.now(),
        "stop",
        TANDEM_SESSION,
        CLAUDE_SESSION,
      );
      const started = Date.now();
      expect(store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })).toBeUndefined();
      // Generous upper bound — the assertion is "bounded", not "exactly 50ms".
      expect(Date.now() - started).toBeLessThan(5000);
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }
  });

  it("recovers on its own once the holder lets go", () => {
    const dir = freshDir();
    const store = new ClaudeLifecycleStore(dir, { busyTimeoutMs: 40 });
    store.record({ kind: "prompt_submit", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });

    const holder = new DatabaseSync(storeFile(dir));
    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO events (ts_ms, kind, tandem_session, claude_session_id) VALUES (?, ?, ?, ?)").run(
      Date.now(),
      "stop",
      TANDEM_SESSION,
      CLAUDE_SESSION,
    );
    expect(store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION })).toBeUndefined();
    holder.exec("ROLLBACK");
    holder.close();

    // No stale-lock timeout to wait out: the next write just works.
    const after = store.record({ kind: "stop", tandemSession: TANDEM_SESSION, claudeSessionId: CLAUDE_SESSION });
    expect(after).toBeDefined();
    expect(after!.seq).toBe(2);
  });
});
