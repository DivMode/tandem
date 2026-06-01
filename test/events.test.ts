import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emitCompletion } from "../bridge/events.ts";

// emitCompletion has three sinks: events.log (always), webhook (if set), ntfy
// (if topic set). Phase 6c adds a `silent` flag that suppresses ONLY the ntfy
// phone push — used for routine per-task completions so the phone isn't buzzed
// on every step. We verify the gating by spying on global fetch (the ntfy POST).

describe("emitCompletion silent flag — gates ONLY the ntfy phone push", () => {
  const prevTopic = process.env.TANDEM_NTFY_TOPIC;
  const prevHook = process.env.TANDEM_DONE_WEBHOOK;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    process.env.TANDEM_NTFY_TOPIC = "tandem-unit-test-topic";
    delete process.env.TANDEM_DONE_WEBHOOK; // isolate: only ntfy could fetch
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevTopic === undefined) delete process.env.TANDEM_NTFY_TOPIC;
    else process.env.TANDEM_NTFY_TOPIC = prevTopic;
    if (prevHook === undefined) delete process.env.TANDEM_DONE_WEBHOOK;
    else process.env.TANDEM_DONE_WEBHOOK = prevHook;
  });

  const ev = { type: "relay" as const, id: "loopX", cursor: 1, summary: "task done" };

  it("buzzes (POSTs ntfy) when silent is not set", () => {
    emitCompletion(ev);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("tandem-unit-test-topic");
  });

  it("does NOT buzz when silent:true", () => {
    emitCompletion({ ...ev, silent: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
