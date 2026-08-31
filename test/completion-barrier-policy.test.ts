/**
 * The foreman COMPLETION BARRIER, and the measured AMBIGUOUS-DELIVERY rule.
 *
 * WHY A BARRIER. Every other reconciliation rule fires at the START of work or
 * after an interruption. Nothing fired at the END, so a foreman could — and
 * did — declare an orchestrated task done while a worker that owned part of it
 * was still running, or had finished with a result nobody read. The barrier is
 * the missing bookend: reconcile before you conclude, and never conclude over
 * an unprocessed current-task worker.
 *
 * WHY AMBIGUOUS DELIVERY IS DOCUMENTED HERE. Measured on this transport: a send
 * can return with no observable state change even though the instruction landed
 * in the worker. That makes "nothing happened, so resend" a corruption bug, not
 * a recovery. The rule is therefore stated where a client actually reads it.
 *
 * THIS SUITE ALSO GUARDS WHAT MUST NOT HAVE MOVED. The reviewer-of-record, the
 * no-monitoring, the interruption/resume and the explicit-user-only Fable rules
 * are asserted alongside, because a policy edit is exactly where they get lost.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  ORCHESTRATION_POLICY,
  ORCHESTRATION_INSTRUCTIONS,
  ORCHESTRATION_POLICY_VERSION,
  TOOL_GUIDANCE,
} = await import("../src/orchestration-policy.ts");

const skill = readFileSync(
  fileURLToPath(new URL("../skills/tandem-orchestration/SKILL.md", import.meta.url)),
  "utf8",
);

const joined = (lines: readonly string[]) => lines.join("\n");

describe("the policy carries a completion barrier", () => {
  it("has a completionBarrier section naming the two reconciliation calls", () => {
    const text = joined(ORCHESTRATION_POLICY.completionBarrier);
    expect(text).toMatch(/list_sessions/);
    expect(text).toMatch(/foreman events/i);
    expect(text).toMatch(/before you declare an orchestrated engineering task done/i);
    expect(text).toMatch(/end an orchestration turn/i);
  });

  it("forbids concluding over a running or unprocessed current-task worker", () => {
    const text = joined(ORCHESTRATION_POLICY.completionBarrier);
    expect(text).toMatch(/never conclude while a worker that owns part of the current task is still running/i);
    expect(text).toMatch(/terminal result you have not processed/i);
    for (const kind of ["completed", "blocked", "needs_input", "interrupted", "error"]) {
      expect(text).toContain(kind);
    }
  });

  it("requires each terminal result to be processed against the original requirement", () => {
    const text = joined(ORCHESTRATION_POLICY.completionBarrier);
    expect(text).toMatch(/against the original requirement/i);
    expect(text).toMatch(/pending the worker/i);
  });

  it("scopes the barrier to the current task, so unrelated work never blocks a turn", () => {
    expect(joined(ORCHESTRATION_POLICY.completionBarrier)).toMatch(
      /unrelated worker running on another job is not a reason to hold this turn open/i,
    );
  });

  it("names the recent_events preview as the fallback for a stale cached schema", () => {
    expect(joined(ORCHESTRATION_POLICY.completionBarrier)).toMatch(/recent_events/);
    expect(joined(ORCHESTRATION_POLICY.completionBarrier)).toMatch(
      /never a substitute for the checkpointed feed/i,
    );
  });
});

describe("the barrier reaches a client through the always-loaded instructions", () => {
  it("appears in the initialize instructions, not only the served policy", () => {
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/BEFORE YOU CALL IT DONE/);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/Never conclude while a current-task worker is still running/i);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/pending the worker/i);
  });

  it("appears in the list_sessions and get_foreman_events tool guidance", () => {
    expect(TOOL_GUIDANCE.listSessions).toMatch(/before you declare an orchestrated task done/i);
    expect(TOOL_GUIDANCE.listSessions).toMatch(/recent_events/);
    expect(TOOL_GUIDANCE.foremanEvents).toMatch(/before you declare an orchestrated task done/i);
  });

  it("is described by the policy tool's own summary", () => {
    expect(TOOL_GUIDANCE.policyTool).toMatch(/completion barrier/i);
    expect(TOOL_GUIDANCE.policyTool).toMatch(/never-auto-resend/i);
    expect(TOOL_GUIDANCE.policyTool).toContain(ORCHESTRATION_POLICY_VERSION);
  });
});

describe("ambiguous delivery is documented, with never-auto-resend as the rule", () => {
  it("states that no state change is not evidence the prompt was lost", () => {
    const text = joined(ORCHESTRATION_POLICY.deliveryAmbiguity);
    expect(text).toMatch(/no state change while the instruction DID in fact land/i);
    expect(text).toMatch(/NOT evidence that the prompt was lost|NOT evidence the prompt was lost/i);
  });

  it("requires reconciliation before any resend", () => {
    const text = joined(ORCHESTRATION_POLICY.deliveryAmbiguity);
    expect(text).toMatch(/NEVER a reason to resend on its own/i);
    expect(text).toMatch(/Reconcile first/i);
    expect(text).toMatch(/Only send again once reconciliation shows the worker never received it/i);
  });

  it("records the finished-pane-still-working case and its lifecycle-hook mitigation", () => {
    const text = joined(ORCHESTRATION_POLICY.deliveryAmbiguity);
    expect(text).toMatch(/keep reporting `working`/i);
    expect(text).toMatch(/lifecycle hook/i);
    expect(text).toMatch(/Claude's own Stop ends the turn/i);
    expect(text).toMatch(/`working` alone never justifies a resend/i);
  });

  it("reaches the instructions and the send_to_session guidance", () => {
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/Delivery is ambiguous/i);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/never auto-resend/i);
    expect(TOOL_GUIDANCE.sendToSession).toMatch(/Delivery is ambiguous/i);
    expect(TOOL_GUIDANCE.sendToSession).toMatch(/never auto-resend/i);
  });
});

describe("the skill carries the same two rules", () => {
  it("has a completion barrier section with the never-conclude rule", () => {
    expect(skill).toMatch(/## Before you call it done/);
    expect(skill).toMatch(/never conclude while a current-task worker is still running/i);
    expect(skill).toMatch(/pending the worker/i);
    expect(skill).toMatch(/unrelated worker running on another job/i);
  });

  it("has an ambiguous-delivery section with the never-auto-resend rule", () => {
    expect(skill).toMatch(/## Delivery is ambiguous — never auto-resend/);
    expect(skill).toMatch(/not evidence the prompt was lost/i);
    expect(skill).toMatch(/keep reporting `working`/i);
    expect(skill).toMatch(/lifecycle hook/i);
  });

  it("adds the barrier to the numbered safety rules and the completion standard", () => {
    expect(skill).toMatch(/^12\. Never declare an orchestrated engineering task done/m);
    expect(skill).toMatch(/the completion barrier above was actually run/i);
  });

  it("documents the additive recent_events field on list_sessions", () => {
    expect(skill).toMatch(/Returns `\{ sessions, recent_events \}`/);
    expect(skill).toMatch(/at most five recent lifecycle transitions/i);
    expect(skill).toMatch(/never a substitute/i);
  });
});

describe("nothing that was already load-bearing was dropped", () => {
  it("keeps the reviewer-of-record and merge authority", () => {
    expect(joined(ORCHESTRATION_POLICY.reviewAuthority)).toMatch(/reviewer of record and the merge authority/i);
    expect(joined(ORCHESTRATION_POLICY.reviewAuthority)).toMatch(/do not self-approve/i);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/reviewer of record and the merge authority/i);
    expect(skill).toMatch(/reviewer of record and the merge authority/i);
  });

  it("keeps the never-monitor rule", () => {
    expect(joined(ORCHESTRATION_POLICY.monitoring)).toMatch(/Never open a session solely to watch another one/i);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/never open a session just to watch one/i);
    expect(skill).toMatch(/Never open a session solely to watch another one/i);
  });

  it("keeps the interruption and resume model", () => {
    expect(joined(ORCHESTRATION_POLICY.interruptionModel)).toMatch(/does NOT stop in-flight Tandem work/i);
    expect(joined(ORCHESTRATION_POLICY.interruptionModel)).toMatch(/resume the SAME worker/i);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/stopping the conversation does not stop the worker/i);
  });

  it("keeps the explicit-user-only Fable rule", () => {
    expect(joined(ORCHESTRATION_POLICY.modelRouting.fable.rules)).toMatch(/EXPLICIT-USER-ONLY/);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/EXPLICIT-USER-ONLY/);
    expect(ORCHESTRATION_POLICY.modelRouting.fable.consentField).toBe("user_requested_fable");
  });

  it("keeps events-are-history and list_sessions-is-liveness", () => {
    expect(joined(ORCHESTRATION_POLICY.reconciliation)).toMatch(/HISTORY/);
    expect(joined(ORCHESTRATION_POLICY.reconciliation)).toMatch(/LIVENESS/);
    expect(joined(ORCHESTRATION_POLICY.completionBarrier)).toMatch(/get_foreman_events/);
  });

  it("bumped the policy version minimally, to 1.3.0", () => {
    expect(ORCHESTRATION_POLICY_VERSION).toBe("1.3.0");
    expect(ORCHESTRATION_INSTRUCTIONS).toContain("v1.3.0");
  });
});
