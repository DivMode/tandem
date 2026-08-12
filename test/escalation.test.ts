import { describe, it, expect } from "vitest";
import { ntfyPayload } from "../bridge/events.ts";

const baseEvent = {
  ts: "2026-05-31T00:00:00.000Z",
  type: "relay" as const,
  status: "done" as const,
  id: "loop42",
  cursor: 999,
  summary: "relay finished: lead reported DONE",
};

describe("ntfyPayload — completion (unchanged phase-5 behavior)", () => {
  it("titles '<id> done', default priority, check tag", () => {
    const p = ntfyPayload(baseEvent);
    expect(p.title).toBe("tandem: loop42 done");
    expect(p.priority).toBe("default");
    expect(p.tags).toBe("white_check_mark");
  });
  it("body carries id, status, cursor and summary", () => {
    const p = ntfyPayload(baseEvent);
    expect(p.body).toContain("loop42");
    expect(p.body).toContain("done");
    expect(p.body).toContain("999");
    expect(p.body).toContain("lead reported DONE");
  });
  it("has no Claude.ai or other client click default", () => {
    expect(ntfyPayload(baseEvent).click).toBeUndefined();
  });
  it("accepts an explicit safe click URL and rejects credential-bearing URLs", () => {
    expect(ntfyPayload(baseEvent, { clickUrl: "https://ops.example/runbook" }).click).toBe(
      "https://ops.example/runbook",
    );
    expect(ntfyPayload(baseEvent, { clickUrl: "https://user:secret@ops.example" }).click).toBeUndefined();
  });
});

describe("ntfyPayload — escalation (manager is stuck, needs the human)", () => {
  it("uses an urgent title/priority/tag distinct from completion", () => {
    const p = ntfyPayload(baseEvent, { escalation: true, reason: "need an API key" });
    expect(p.title).toBe("tandem: loop42 NEEDS YOU");
    expect(p.priority).toBe("urgent");
    expect(p.tags).toContain("warning");
    expect(p.title).not.toBe("tandem: loop42 done");
  });
  it("body surfaces the blocking reason so the push is actionable", () => {
    const p = ntfyPayload(baseEvent, { escalation: true, reason: "need an API key" });
    expect(p.body).toContain("need an API key");
  });
});

describe("ntfyPayload — needs-input (manager asked a question, staying alive)", () => {
  it("uses a distinct 'NEEDS YOUR ANSWER' title, urgent, with a question tag", () => {
    const p = ntfyPayload(baseEvent, { needsInput: true, reason: "which region?" });
    expect(p.title).toBe("tandem: loop42 NEEDS YOUR ANSWER");
    expect(p.priority).toBe("urgent");
    expect(p.tags).toContain("question");
    // distinct from both completion ('done') and terminal escalation ('NEEDS YOU')
    expect(p.title).not.toBe("tandem: loop42 done");
    expect(p.title).not.toBe("tandem: loop42 NEEDS YOU");
  });
  it("body carries the question text", () => {
    const p = ntfyPayload(baseEvent, { needsInput: true, reason: "which region?" });
    expect(p.body).toContain("which region?");
  });
});
