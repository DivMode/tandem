import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLedger } from "../bridge/turn-ledger.ts";

/**
 * The turn ledger is what makes "this turn has already been reported" a durable
 * fact rather than a process-local one. A NEW TurnLedger instance over the same
 * directory is exactly what a restarted bridge gets — the class caches nothing,
 * so every assertion below about a second instance is an assertion about
 * surviving a restart.
 */

const roots: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tandem-turns-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT = "tmux:$4:1756500000";

describe("claiming a completion exactly once", () => {
  it("returns the turn the first time and undefined every time after", () => {
    const ledger = new TurnLedger(freshDir());
    ledger.beginTurn("review", AGENT);
    expect(ledger.completeTurn("review", AGENT)).toMatchObject({ epoch: 1, turnSeq: 1 });
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
  });

  it("reports nothing for a session that is merely idle without a Tandem-driven turn", () => {
    const ledger = new TurnLedger(freshDir());
    // No beginTurn: a human typed into the TUI directly.
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
  });

  it("counts each new turn separately", () => {
    const ledger = new TurnLedger(freshDir());
    ledger.beginTurn("review", AGENT);
    expect(ledger.completeTurn("review", AGENT)!.turnSeq).toBe(1);
    ledger.beginTurn("review", AGENT);
    expect(ledger.completeTurn("review", AGENT)!.turnSeq).toBe(2);
  });
});

describe("durability across a bridge restart", () => {
  it("a turn left in flight is still claimable, exactly once, by a NEW instance", () => {
    const dir = freshDir();
    // Process 1: send() delivered the instruction, then returned "running".
    new TurnLedger(dir).beginTurn("review", AGENT);

    // Process 2 (restart): the first poll completes the turn...
    expect(new TurnLedger(dir).completeTurn("review", AGENT)).toMatchObject({ turnSeq: 1 });
    // ...and every later poll, in this process or another, reports nothing.
    expect(new TurnLedger(dir).completeTurn("review", AGENT)).toBeUndefined();
    expect(new TurnLedger(dir).completeTurn("review", AGENT)).toBeUndefined();
  });

  it("a completed turn stays completed after a restart", () => {
    const dir = freshDir();
    const first = new TurnLedger(dir);
    first.beginTurn("review", AGENT);
    first.completeTurn("review", AGENT);
    expect(new TurnLedger(dir).completeTurn("review", AGENT)).toBeUndefined();
  });

  it("stores state owner-only in a 0700 directory", () => {
    const dir = freshDir();
    new TurnLedger(dir).beginTurn("review", AGENT);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

describe("incarnation identity (close/reopen under one name)", () => {
  it("bumps the epoch when the agent behind a name changes", () => {
    const dir = freshDir();
    const ledger = new TurnLedger(dir);
    ledger.beginTurn("review", AGENT);
    ledger.completeTurn("review", AGENT);

    // Same name, different agent: a reopened session.
    const reopened = "tmux:$9:1756599999";
    const { turn: ref } = ledger.beginTurn("review", reopened);
    expect(ref.epoch).toBe(2);
    // turnSeq is monotonic and never reset, so even a lost epoch could not
    // make a new turn collide with an old one.
    expect(ref.turnSeq).toBe(2);
  });

  it("does NOT let a new agent complete the previous agent's turn", () => {
    const dir = freshDir();
    const ledger = new TurnLedger(dir);
    ledger.beginTurn("review", AGENT);
    // The session was closed and reopened before the turn was ever observed.
    expect(ledger.completeTurn("review", "herdr:ws-2:term-2")).toBeUndefined();
  });

  it("keeps the entry after a close so a reopened name cannot reuse its ids", () => {
    const dir = freshDir();
    const ledger = new TurnLedger(dir);
    ledger.beginTurn("review", AGENT);
    ledger.completeTurn("review", AGENT);
    const closed = ledger.sessionRef("review", AGENT);
    const { turn: reopenedFirstTurn } = ledger.beginTurn("review", "tmux:$9:1756599999");
    expect(reopenedFirstTurn.turnSeq).toBeGreaterThan(closed.turnSeq);
    expect(reopenedFirstTurn.epoch).toBeGreaterThan(closed.epoch);
  });
});

describe("a second send while a turn is in flight", () => {
  it("reports the superseded turn once, and the new turn is the one that completes", () => {
    const ledger = new TurnLedger(freshDir());
    const first = ledger.beginTurn("review", AGENT);
    expect(first.superseded).toBeUndefined();

    const second = ledger.beginTurn("review", AGENT);
    expect(second.superseded).toMatchObject({ turnSeq: 1, epoch: 1 });
    expect(second.turn.turnSeq).toBe(2);

    // Only the live turn can complete, and only once.
    expect(ledger.completeTurn("review", AGENT)).toMatchObject({ turnSeq: 2 });
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
  });

  it("does not report a superseded turn when the previous one already finished", () => {
    const ledger = new TurnLedger(freshDir());
    ledger.beginTurn("review", AGENT);
    ledger.completeTurn("review", AGENT);
    expect(ledger.beginTurn("review", AGENT).superseded).toBeUndefined();
  });

  it("survives a restart: the pending turn a previous process left is still superseded", () => {
    const dir = freshDir();
    new TurnLedger(dir).beginTurn("review", AGENT);
    expect(new TurnLedger(dir).beginTurn("review", AGENT).superseded).toMatchObject({ turnSeq: 1 });
  });
});

describe("aborting a turn", () => {
  it("returns the turn once, and a later completion reports nothing", () => {
    const ledger = new TurnLedger(freshDir());
    ledger.beginTurn("review", AGENT);
    expect(ledger.abortTurn("review", AGENT)).toMatchObject({ turnSeq: 1 });
    expect(ledger.abortTurn("review", AGENT)).toBeUndefined();
    // An interrupted turn must never later surface as a completion.
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
  });
});

describe("an unwritable state directory degrades instead of breaking the session", () => {
  it("still de-duplicates in memory when durable writes fail", () => {
    // Regression: the ledger used to propagate the write failure out of
    // beginTurn and straight through handleSend, so an unwritable state
    // directory (read-only disk, full disk, a suite stubbing node:fs) broke the
    // send it was only supposed to report on. Reporting must never do that.
    const dir = freshDir();
    const ledger = new TurnLedger(dir);
    // Replace the directory with a FILE so every mkdir/write beneath it fails.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "not a directory");

    expect(() => ledger.beginTurn("review", AGENT)).not.toThrow();
    // Dedupe still holds for the case that actually caused duplicates:
    // repeated polls inside one process.
    expect(ledger.completeTurn("review", AGENT)).toMatchObject({ turnSeq: 1 });
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
  });

  it("prefers the in-memory record over a stale file a failed write left behind", () => {
    const dir = freshDir();
    const ledger = new TurnLedger(dir);
    ledger.beginTurn("review", AGENT);
    ledger.completeTurn("review", AGENT);

    // Roll the on-disk file back to the pending state a crashed write could
    // leave. The completed turn must not be resurrected.
    const [file] = readdirSync(dir);
    const stale = JSON.parse(readFileSync(join(dir, file!), "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(dir, file!),
      JSON.stringify({ ...stale, pendingTurn: 1, updatedAt: (stale.updatedAt as number) - 60_000 }),
      { mode: 0o600 },
    );
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
  });
});

describe("untrusted or damaged state", () => {
  it("treats an unreadable directory as no prior state rather than failing", () => {
    const ledger = new TurnLedger(join(freshDir(), "does", "not", "exist"));
    expect(ledger.completeTurn("review", AGENT)).toBeUndefined();
    // And can still begin a turn once it is able to create the directory.
    expect(ledger.beginTurn("review", AGENT).turn).toMatchObject({ turnSeq: 1 });
  });

  it("names state files by hash, so a session name never reaches the filesystem", () => {
    const dir = freshDir();
    const ledger = new TurnLedger(dir);
    ledger.beginTurn("review", AGENT);
    expect(ledger.inspect("review")).toMatchObject({ pendingTurn: 1 });
    // The readable name is not part of any path under the state directory.
    expect(readdirSync(dir).some((f) => f.includes("review"))).toBe(false);
  });
});
