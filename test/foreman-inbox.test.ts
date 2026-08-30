import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForemanInbox,
  InvalidCheckpointError,
  MAX_RETAINED_EVENTS,
  MAX_TEXT_CHARS,
  sanitizeEventText,
  type ForemanEventInput,
} from "../bridge/foreman-inbox.ts";

/**
 * The foreman inbox: the durable, bounded, checkpointed record a returning
 * foreman reconciles against. Every test here uses an INJECTED temp directory —
 * nothing in this file may touch real home state.
 */

const roots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tandem-inbox-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ev(over: Partial<ForemanEventInput> = {}): ForemanEventInput {
  return {
    kind: "completed",
    source: "session",
    localName: "review",
    epoch: 1,
    turn: 1,
    engine: "claude",
    device: "local",
    summary: "did the thing",
    ...over,
  };
}

describe("durability across a bridge restart", () => {
  it("a second ForemanInbox over the same directory reads what the first recorded", () => {
    const dir = freshDir();
    new ForemanInbox(dir).record(ev({ turn: 1, summary: "first turn" }));
    new ForemanInbox(dir).record(ev({ turn: 2, summary: "second turn" }));

    // A brand-new instance is what a restarted bridge process gets.
    const afterRestart = new ForemanInbox(dir).read();
    expect(afterRestart.events).toHaveLength(2);
    expect(afterRestart.events.map((e) => e.summary)).toEqual(["first turn", "second turn"]);
  });

  it("keeps the store file owner-only inside a 0700 directory", () => {
    const dir = freshDir();
    new ForemanInbox(dir).record(ev());
    expect(statSync(join(dir, "events.json")).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

describe("de-duplication by construction", () => {
  it("re-recording the same transition of the same turn is a no-op", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    expect(inbox.record(ev())).toBeDefined();
    expect(inbox.record(ev())).toBeUndefined();
    expect(inbox.read().events).toHaveLength(1);
  });

  it("survives a restart: a duplicate recorded by a NEW instance is still suppressed", () => {
    const dir = freshDir();
    new ForemanInbox(dir).record(ev());
    expect(new ForemanInbox(dir).record(ev())).toBeUndefined();
    expect(new ForemanInbox(dir).read().events).toHaveLength(1);
  });

  it("does NOT collide across close/reopen of the same session name (epoch differs)", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev({ epoch: 1, turn: 1, summary: "first agent" }));
    inbox.record(ev({ epoch: 2, turn: 1, summary: "second agent, same name" }));
    const events = inbox.read().events;
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it("distinguishes different kinds of the same turn", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev({ kind: "completed" }));
    inbox.record(ev({ kind: "interrupted" }));
    expect(inbox.read().events.map((e) => e.kind)).toEqual(["completed", "interrupted"]);
  });
});

describe("lifecycle kinds", () => {
  it("records blocked, needs_input, interrupted, closed and error as distinct kinds", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    const kinds = ["completed", "blocked", "needs_input", "interrupted", "closed", "error"] as const;
    kinds.forEach((kind, i) => inbox.record(ev({ kind, turn: i + 1 })));
    expect(inbox.read().events.map((e) => e.kind)).toEqual([...kinds]);
  });

  it("flags exactly the transitions a foreman must look at", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev({ kind: "blocked", turn: 1, reason: "needs a decision" }));
    inbox.record(ev({ kind: "closed", turn: 2 }));
    const [blocked, closed] = inbox.read().events;
    expect(blocked!.needs_foreman_review).toBe(true);
    expect(blocked!.reason).toBe("needs a decision");
    expect(closed!.needs_foreman_review).toBe(false);
  });

  it("carries the composite device:localName identity, never a bare local name alone", () => {
    const dir = freshDir();
    new ForemanInbox(dir).record(ev({ device: "studio", localName: "review" }));
    const event = new ForemanInbox(dir).read().events[0]!;
    expect(event.device).toBe("studio");
    expect(event.localName).toBe("review");
    expect(event.session).toBe("studio:review");
  });
});

describe("client-carried checkpoints", () => {
  it("returns only what is new since the caller's checkpoint", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev({ turn: 1 }));
    const first = inbox.read();
    expect(first.events).toHaveLength(1);

    inbox.record(ev({ turn: 2 }));
    const second = inbox.read({ since: first.checkpoint });
    expect(second.events.map((e) => e.turn)).toEqual([2]);

    // Reading again with the newest checkpoint yields nothing.
    expect(inbox.read({ since: second.checkpoint }).events).toEqual([]);
  });

  it("is idempotent: reading the same checkpoint twice returns the same events (no server-side ack)", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev({ turn: 1 }));
    const base = inbox.read({ limit: 1 });
    inbox.record(ev({ turn: 2 }));
    const a = inbox.read({ since: base.checkpoint });
    const b = inbox.read({ since: base.checkpoint });
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
  });

  it("pages forward with `more`, advancing the checkpoint only as far as each page reached", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    for (let i = 1; i <= 5; i++) inbox.record(ev({ turn: i }));

    // Anchor on everything recorded so far, then add three more.
    const anchor = inbox.read({ limit: 200 });
    expect(anchor.events.map((e) => e.turn)).toEqual([1, 2, 3, 4, 5]);
    expect(anchor.more).toBe(false);
    expect(anchor.truncated).toBe(false);
    for (let i = 6; i <= 8; i++) inbox.record(ev({ turn: i }));

    const first = inbox.read({ since: anchor.checkpoint, limit: 2 });
    expect(first.events.map((e) => e.turn)).toEqual([6, 7]);
    expect(first.more).toBe(true);

    const second = inbox.read({ since: first.checkpoint, limit: 2 });
    expect(second.events.map((e) => e.turn)).toEqual([8]);
    expect(second.more).toBe(false);

    // Fully drained.
    expect(inbox.read({ since: second.checkpoint }).events).toEqual([]);
  });

  it("with no checkpoint starts at the OLDEST retained event and pages forward", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    for (let i = 1; i <= 5; i++) inbox.record(ev({ turn: i }));

    const page = inbox.read({ limit: 2 });
    expect(page.events.map((e) => e.turn)).toEqual([1, 2]);
    // Cut short by `limit` is pagination, NOT loss.
    expect(page.more).toBe(true);
    expect(page.truncated).toBe(false);

    const rest = inbox.read({ since: page.checkpoint, limit: 10 });
    expect(rest.events.map((e) => e.turn)).toEqual([3, 4, 5]);
    expect(rest.more).toBe(false);
    expect(rest.truncated).toBe(false);
  });

  it("reports an empty store as neither more nor truncated", () => {
    const page = new ForemanInbox(freshDir()).read();
    expect(page.events).toEqual([]);
    expect(page.more).toBe(false);
    expect(page.truncated).toBe(false);
    expect(page.counts).toEqual({ returned: 0, retained: 0 });
  });

  it("issues a STABLE checkpoint for an empty inbox, and honours it once events arrive", () => {
    // Regression: an empty store used to mint a random epoch on every read, so
    // two reads of the same empty inbox disagreed, and a checkpoint taken
    // before the first event was later reported as coming from a different
    // store — a false "you missed history" on every first-ever read.
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    const a = inbox.read();
    const b = inbox.read();
    expect(a.checkpoint).toBe(b.checkpoint);
    expect(a.truncated).toBe(false);

    inbox.record(ev({ turn: 1 }));
    inbox.record(ev({ turn: 2 }));
    const since = inbox.read({ since: a.checkpoint });
    expect(since.events.map((e) => e.turn)).toEqual([1, 2]);
    expect(since.truncated).toBe(false); // nothing was actually missed
  });

  it("reports truncated when the store it checkpointed has since been wiped", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev());
    const before = inbox.read();
    rmSync(join(dir, "events.json"), { force: true });
    const after = inbox.read({ since: before.checkpoint });
    expect(after.events).toEqual([]);
    expect(after.truncated).toBe(true);
  });

  it("rejects a malformed checkpoint explicitly instead of silently guessing", () => {
    const inbox = new ForemanInbox(freshDir());
    expect(() => inbox.read({ since: "not-a-checkpoint" })).toThrow(InvalidCheckpointError);
    expect(() => inbox.read({ since: "fe1_%%%" })).toThrow(InvalidCheckpointError);
  });

  it("reports truncated when the checkpoint came from a different store", () => {
    const a = new ForemanInbox(freshDir());
    const b = new ForemanInbox(freshDir());
    a.record(ev());
    b.record(ev());
    const fromA = a.read();
    const inB = b.read({ since: fromA.checkpoint });
    expect(inB.truncated).toBe(true);
  });
});

describe("bounded retention", () => {
  it("never retains more than the cap, keeps the NEWEST, and reports truncation", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    const overflow = MAX_RETAINED_EVENTS + 25;
    for (let i = 1; i <= overflow; i++) inbox.record(ev({ turn: i, summary: `turn ${i}` }));

    const page = inbox.read({ limit: 200 });
    expect(page.counts.retained).toBe(MAX_RETAINED_EVENTS);
    // Rotation really did drop events this reader never saw.
    expect(page.truncated).toBe(true);
    // The newest survived; the oldest were dropped.
    expect(page.events.at(0)!.summary).toBe(`turn ${overflow - MAX_RETAINED_EVENTS + 1}`);

    const stored = JSON.parse(readFileSync(join(dir, "events.json"), "utf8")) as { events: unknown[] };
    expect(stored.events).toHaveLength(MAX_RETAINED_EVENTS);
  });

  it("separates pagination from rotation on a stale checkpoint", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev({ turn: 1 }));
    const early = inbox.read();
    expect(early.truncated).toBe(false);

    // A few more events: the caller is merely behind, nothing is lost.
    for (let i = 2; i <= 4; i++) inbox.record(ev({ turn: i }));
    const behind = inbox.read({ since: early.checkpoint, limit: 2 });
    expect(behind.more).toBe(true);
    expect(behind.truncated).toBe(false);

    // Now rotate past that position: the same checkpoint becomes lossy.
    for (let i = 5; i <= MAX_RETAINED_EVENTS + 10; i++) inbox.record(ev({ turn: i }));
    expect(inbox.read({ since: early.checkpoint }).truncated).toBe(true);
  });

  it("tells a caller whose checkpoint fell off the end that history was dropped", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev({ turn: 1 }));
    const early = inbox.read();
    for (let i = 2; i <= MAX_RETAINED_EVENTS + 10; i++) inbox.record(ev({ turn: i }));
    expect(inbox.read({ since: early.checkpoint }).truncated).toBe(true);
  });

  it("drops an unparseable store rather than throwing, and keeps working afterwards", () => {
    const dir = freshDir();
    const inbox = new ForemanInbox(dir);
    inbox.record(ev());
    writeFileSync(join(dir, "events.json"), "{ not json", { mode: 0o600 });
    expect(inbox.read().events).toEqual([]);
    expect(inbox.record(ev({ turn: 9 }))).toBeDefined();
    expect(inbox.read().events).toHaveLength(1);
  });
});

describe("no sensitive data leaves the host", () => {
  it("redacts credential-shaped runs", () => {
    expect(sanitizeEventText("token is ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain("<token>");
    expect(sanitizeEventText("use sk-abcdefghijklmnopqrstuvwx now")).toContain("<token>");
    expect(sanitizeEventText("AWS AKIAIOSFODNN7EXAMPLE here")).toContain("<token>");
    expect(sanitizeEventText("password = hunter2")).toMatch(/password=<redacted>/i);
    expect(sanitizeEventText("Authorization: Bearer abc.def.ghi")).toMatch(/<redacted>/i);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(sanitizeEventText(`token ${jwt}`)).not.toContain(jwt);
  });

  it("redacts absolute paths and URLs", () => {
    const out = sanitizeEventText("edited /Users/someone/Developer/secret/app.ts and ~/.ssh/id_rsa");
    expect(out).not.toContain("/Users/someone");
    expect(out).not.toContain(".ssh");
    expect(out).toContain("<path>");
    expect(sanitizeEventText("see https://internal.example.com/a/b?token=x")).not.toContain("internal.example.com");
  });

  it("strips ANSI escapes and control bytes from terminal output", () => {
    const esc = String.fromCharCode(27);
    const raw = `${esc}[31mred${esc}[0m line\u0007 two`;
    const out = sanitizeEventText(raw);
    expect(out).toContain("red");
    expect(out).toContain("line");
    // No C0 control byte, DEL, or bare ESC may survive into a client-visible field.
    expect(/[\u0000-\u001f\u007f]/.test(out)).toBe(false);
    expect(out).not.toContain("[31m");
  });

  it("clamps every free-text field to 200 characters", () => {
    const long = "a".repeat(5000);
    expect(sanitizeEventText(long).length).toBeLessThanOrEqual(MAX_TEXT_CHARS);

    const dir = freshDir();
    new ForemanInbox(dir).record(ev({ summary: long, reason: long }));
    const event = new ForemanInbox(dir).read().events[0]!;
    expect(event.summary!.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(event.reason!.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  it("never stores a transcript, tool arguments, an attach hint, a cwd, or an env", () => {
    const dir = freshDir();
    new ForemanInbox(dir).record(ev({ summary: "ok" }));
    const event = new ForemanInbox(dir).read().events[0]! as unknown as Record<string, unknown>;
    for (const forbidden of ["cwd", "project", "attachHint", "handoff", "text", "report", "env", "args", "transcript"]) {
      expect(Object.hasOwn(event, forbidden), `event must not carry ${forbidden}`).toBe(false);
    }
    // Exactly the intended shape, so a future field cannot be added silently.
    expect(Object.keys(event).sort()).toEqual(
      ["device", "engine", "epoch", "id", "kind", "localName", "needs_foreman_review", "seq", "session", "source", "summary", "ts", "turn", "v"].sort(),
    );
  });

  it("omits free text entirely when the host opts out", () => {
    const dir = freshDir();
    const previous = process.env.TANDEM_FOREMAN_EVENT_SUMMARIES;
    process.env.TANDEM_FOREMAN_EVENT_SUMMARIES = "0";
    try {
      new ForemanInbox(dir).record(ev({ summary: "something private", reason: "also private" }));
    } finally {
      if (previous === undefined) delete process.env.TANDEM_FOREMAN_EVENT_SUMMARIES;
      else process.env.TANDEM_FOREMAN_EVENT_SUMMARIES = previous;
    }
    const event = new ForemanInbox(dir).read().events[0]!;
    expect(event.summary).toBeUndefined();
    expect(event.reason).toBeUndefined();
    expect(event.kind).toBe("completed"); // the transition itself still reported
  });
});
