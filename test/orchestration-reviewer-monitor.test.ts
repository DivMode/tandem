import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildMcpServer } from "../src/mcp-server.ts";
import {
  ORCHESTRATION_INSTRUCTIONS,
  ORCHESTRATION_POLICY,
  ORCHESTRATION_POLICY_VERSION,
  TOOL_GUIDANCE,
} from "../src/orchestration-policy.ts";

/**
 * The reviewer/monitor hierarchy, synchronised from the canonical machine
 * policy (nix-config ai/instructions/orchestration.md, PR #27).
 *
 * WHY THESE ASSERT ON THE STRUCTURED POLICY, NOT JUST THE TEXT. The canonical
 * policy's own build check learned this the hard way: a rule moved out of the
 * numbered list into the surrounding commentary keeps every word and loses all
 * its force, and a whole-document grep cannot tell the difference. So each rule
 * below is pinned to the SECTION it must live in — `reviewAuthority`,
 * `monitoring`, or the ChatGPT role — and a reword is free while a demotion
 * into prose elsewhere fails.
 *
 * Both halves of each rule are pinned separately, because either half alone
 * survives an edit that inverts it: "a separate reviewer is optional" without
 * "not a substitute" turns an optional second opinion into the merge decision,
 * and a ban on monitoring sessions without the mechanism that replaces it
 * leaves a foreman no way to see progress, which is how the banned session gets
 * opened again.
 */

const SKILL = readFileSync(
  fileURLToPath(new URL("../skills/tandem-orchestration/SKILL.md", import.meta.url)),
  "utf8",
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function connectedClient() {
  const server = buildMcpServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** The joined text of one named policy section. */
const section = (lines: readonly string[]) => lines.join("\n");

describe("ChatGPT is the reviewer of record and merge authority", () => {
  const chatgpt = ORCHESTRATION_POLICY.roles.find((r) => /ChatGPT/.test(r.actor));

  it("says so in the ROLE itself, not somewhere in the prose", () => {
    // A standing fact about who ChatGPT is belongs in Roles; as a step in a
    // list it would read as something to do once rather than what it is.
    expect(chatgpt).toBeDefined();
    expect(chatgpt!.role).toMatch(/reviewer of record/i);
    expect(chatgpt!.role).toMatch(/merge authority/i);
    expect(chatgpt!.role).toMatch(/implementation workers supply code, tests and evidence/i);
  });

  it("keeps the foreman role it already had", () => {
    expect(chatgpt!.role).toMatch(/foreman/i);
    expect(chatgpt!.role).toMatch(/does not do the engineering itself/i);
  });

  it("reaches a connected client in the initialize instructions", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/reviewer of record/i);
    expect(instructions).toMatch(/merge authority/i);
  });
});

describe("implementation workers do not self-approve", () => {
  const text = section(ORCHESTRATION_POLICY.reviewAuthority);

  it("is a rule in the reviewAuthority section", () => {
    expect(ORCHESTRATION_POLICY.reviewAuthority.length).toBeGreaterThan(0);
    expect(text).toMatch(/do not self-approve/i);
    expect(text).toMatch(/not an independent review/i);
  });

  it("says to review the diff rather than the worker's own summary", () => {
    expect(text).toMatch(/diff/i);
    expect(text).toMatch(/original requirement/i);
    expect(text).toMatch(/summary of itself/i);
  });

  it("is carried in the always-loaded instructions under its own heading", () => {
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/^REVIEW — you are the reviewer of record and the merge authority$/m);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/do NOT self-approve/);
  });
});

describe("a separate Claude reviewer is optional, not mandatory", () => {
  const text = section(ORCHESTRATION_POLICY.reviewAuthority);

  it("states the optionality explicitly", () => {
    expect(text).toMatch(/optional, not mandatory/i);
  });

  it("names when it IS warranted, so 'optional' does not collapse into 'never'", () => {
    for (const trigger of [
      /security/i,
      /protocol and MCP behaviour/i,
      /Nix and system state/i,
      /migrations/i,
      /concurrency and shared state/i,
      /large refactors/i,
    ]) {
      expect(text, `reviewAuthority must name ${trigger}`).toMatch(trigger);
    }
    expect(text).toMatch(/genuinely independent read/i);
  });

  it("keeps the verdict as EVIDENCE and not the merge decision", () => {
    // The half that stops an optional second opinion from silently becoming
    // the approval gate.
    expect(text).toMatch(/evidence for you, not a substitute for your review and merge decision/i);
  });

  it("says to skip it for small work, and to say so", () => {
    expect(text).toMatch(/skip the extra reviewer for small, low-risk, plainly correct work/i);
    expect(text).toMatch(/say that you skipped it/i);
  });

  it("reaches a connected client with both halves intact", async () => {
    const instructions = (await connectedClient()).getInstructions() ?? "";
    expect(instructions).toMatch(/OPTIONAL/);
    expect(instructions).toMatch(/never a substitute for your own review and merge decision/i);
  });
});

describe("never open a session solely to watch another", () => {
  const text = section(ORCHESTRATION_POLICY.monitoring);

  it("is a rule in the monitoring section", () => {
    expect(ORCHESTRATION_POLICY.monitoring.length).toBeGreaterThan(0);
    expect(text).toMatch(/never open a session solely to watch another one/i);
  });

  it("gives the reason, so the rule is not merely an assertion", () => {
    expect(text).toMatch(/costs a model/i);
    expect(text).toMatch(/duplicate ownership/i);
  });

  it("names the mechanism that REPLACES a watcher", () => {
    // Without this half a foreman has no sanctioned way to observe progress,
    // which is exactly how the banned session gets opened again.
    expect(text).toMatch(/list_sessions/);
    expect(text).toMatch(/empty text and its cursor/i);
    expect(text).toMatch(/get_foreman_events/);
  });

  it("allows a health probe only as an exception, and requires closing it", () => {
    expect(text).toMatch(/short read-only health probe is exceptional/i);
    expect(text).toMatch(/inconsistent or stuck/i);
    expect(text).toMatch(/not merely because a turn is taking a while/i);
    expect(text).toMatch(/closed immediately afterwards/i);
  });

  it("is carried in the always-loaded instructions under its own heading", () => {
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/^MONITORING — never open a session just to watch one$/m);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/closed immediately/i);
  });

  it("warns at the exact moment the mistake would be made: open_session's description", async () => {
    const { tools } = await (await connectedClient()).listTools();
    const description = tools.find((t) => t.name === "open_session")!.description ?? "";
    expect(description).toMatch(/Never open a session solely to WATCH another one/i);
    expect(description).toMatch(/closed immediately/i);
    expect(TOOL_GUIDANCE.openSession).toMatch(/solely to WATCH/i);
  });
});

describe("the rules are placed, not merely present", () => {
  /** A phrase that must appear in ONE named section and nowhere else can be
   *  moved into commentary without any whole-document check noticing. */
  const placements: Array<{ phrase: RegExp; section: readonly string[]; name: string }> = [
    { phrase: /do not self-approve/i, section: ORCHESTRATION_POLICY.reviewAuthority, name: "reviewAuthority" },
    { phrase: /optional, not mandatory/i, section: ORCHESTRATION_POLICY.reviewAuthority, name: "reviewAuthority" },
    { phrase: /not a substitute for your review and merge decision/i, section: ORCHESTRATION_POLICY.reviewAuthority, name: "reviewAuthority" },
    { phrase: /never open a session solely to watch another one/i, section: ORCHESTRATION_POLICY.monitoring, name: "monitoring" },
    { phrase: /closed immediately afterwards/i, section: ORCHESTRATION_POLICY.monitoring, name: "monitoring" },
  ];

  it.each(placements)("$name carries: $phrase", ({ phrase, section: lines }) => {
    expect(section(lines)).toMatch(phrase);
  });

  it("keeps both new sections non-empty in the served policy object", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_orchestration_policy", arguments: {} });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
      policy: typeof ORCHESTRATION_POLICY;
      version: string;
    };
    expect(parsed.version).toBe(ORCHESTRATION_POLICY_VERSION);
    expect(parsed.policy.reviewAuthority.length).toBeGreaterThanOrEqual(4);
    expect(parsed.policy.monitoring.length).toBeGreaterThanOrEqual(3);
    expect(parsed.policy).toEqual(ORCHESTRATION_POLICY);
  });
});

describe("the previously agreed rules survive this change", () => {
  it("keeps session reuse discipline", () => {
    const text = section(ORCHESTRATION_POLICY.sessionDiscipline);
    expect(text).toMatch(/list_sessions BEFORE open_session/i);
    expect(text).toMatch(/reused: true/);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/SESSIONS — list and reuse before you open/);
  });

  it("keeps the interruption model", () => {
    const text = section(ORCHESTRATION_POLICY.interruptionModel);
    expect(text).toMatch(/does NOT stop in-flight Tandem work/i);
    expect(text).toMatch(/resume the SAME worker/i);
  });

  it("keeps the long-turn polling protocol", () => {
    const text = section(ORCHESTRATION_POLICY.pollingProtocol);
    expect(text).toMatch(/STILL EXECUTING/);
    expect(text).toMatch(/NEVER resend/);
    expect(text).toMatch(/empty text/i);
  });

  it("keeps event reconciliation", () => {
    const text = section(ORCHESTRATION_POLICY.reconciliation);
    expect(text).toMatch(/get_foreman_events/);
    expect(text).toMatch(/list_sessions is LIVENESS|liveness/i);
  });

  it("keeps the Opus default and the explicit-user-only Fable gate", () => {
    expect(ORCHESTRATION_POLICY.modelRouting.defaultModel).toBe("opus");
    expect(ORCHESTRATION_POLICY.modelRouting.fable.alias).toBe("fable");
    expect(ORCHESTRATION_POLICY.modelRouting.fable.consentField).toBe("user_requested_fable");
    const fable = section(ORCHESTRATION_POLICY.modelRouting.fable.rules);
    expect(fable).toMatch(/EXPLICIT-USER-ONLY/);
    expect(fable).toMatch(/Never infer it/i);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/EXPLICIT-USER-ONLY/);
  });
});

describe("versioning and concision", () => {
  it("bumped past the version that lacked these rules", () => {
    expect(ORCHESTRATION_POLICY_VERSION).toBe("1.2.0");
    expect(ORCHESTRATION_INSTRUCTIONS).toContain(`v${ORCHESTRATION_POLICY_VERSION}`);
  });

  it("keeps the always-loaded instructions compact, deferring detail to the tool", () => {
    // These are pasted into a system prompt on every connect, so growth here is
    // a real cost. The full text lives behind get_orchestration_policy.
    const lines = ORCHESTRATION_INSTRUCTIONS.split("\n");
    expect(lines.length).toBeLessThan(60);
    expect(ORCHESTRATION_INSTRUCTIONS.length).toBeLessThan(7000);
    // The served policy is genuinely larger than the hint it summarises.
    expect(JSON.stringify(ORCHESTRATION_POLICY).length).toBeGreaterThan(ORCHESTRATION_INSTRUCTIONS.length);
    expect(ORCHESTRATION_INSTRUCTIONS).toMatch(/Call get_orchestration_policy for the full versioned policy/);
  });
});

describe("the packaged skill does not contradict the policy", () => {
  it("states the reviewer-of-record and no-self-approval rules", () => {
    expect(SKILL).toMatch(/reviewer of record and the merge authority/i);
    expect(SKILL).toMatch(/do not approve their own work/i);
    expect(SKILL).toMatch(/optional, not mandatory/i);
    expect(SKILL).toMatch(/not a substitute for the foreman's review and merge decision/i);
  });

  it("states the no-monitoring-session rule with its replacement mechanism", () => {
    expect(SKILL).toMatch(/Never open a session solely to watch another one/i);
    expect(SKILL).toMatch(/get_foreman_events/);
    expect(SKILL).toMatch(/closed immediately afterwards/i);
  });

  it("carries them as numbered safety rules, not only as prose", () => {
    // Same reasoning as the policy placement checks: a rule demoted into
    // narrative keeps its words and loses its force.
    expect(SKILL).toMatch(/^10\. Implementation workers do not self-approve\./m);
    expect(SKILL).toMatch(/^11\. Never open a session solely to watch another one\./m);
  });
});
