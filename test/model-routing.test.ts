import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import type { TerminalSessionLike } from "../bridge/engines/terminal-adapter.ts";
import type { TerminalBackend, TerminalBackendSpawnOptions } from "../bridge/terminal-backend.ts";
import type { DrivableSession, EngineId } from "../bridge/drivable.ts";

/**
 * The ENFORCED half of model routing (bridge/model-policy.ts, applied in
 * bridge/router.ts). Text in a tool description is a hint; these assertions are
 * about what the router actually does, observed at the two places that matter:
 * the options handed to the terminal backend's spawn(), and the per-turn
 * controls handed to a live session's send().
 *
 * No real tmux/Herdr/engine process is involved: the terminal backend is
 * replaced wholesale, and per-turn cases drive a fake DrivableSession seeded
 * into the same registry the router reads from. Every Fable rejection is
 * additionally checked to have happened BEFORE any spawn.
 */

// Must be set before router.ts is imported — it builds the cwd allowlist from
// env at module load. Restored in afterAll: vitest isolates files, but this
// process's env is shared with any file a worker runs later, and a leaked
// allowlist would silently defeat test/allowlist.test.ts's fail-closed
// assertion depending on run order. The router has already captured its
// allowlist by then, so restoring costs these tests nothing.
const priorEnv = {
  CCM_CWD_ALLOWLIST: process.env.CCM_CWD_ALLOWLIST,
  CCM_DEFAULT_CWD: process.env.CCM_DEFAULT_CWD,
};
process.env.CCM_CWD_ALLOWLIST = "/tmp";
process.env.CCM_DEFAULT_CWD = "/tmp";
afterAll(() => {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const spawnCalls: TerminalBackendSpawnOptions[] = [];

function fakeTerminal(name: string): TerminalSessionLike {
  return {
    name,
    cwd: "/tmp",
    ready: true,
    readinessWarning: undefined,
    attachHint: () => "fake attach",
    isAlive: async () => true,
    isCurrentlyWorking: async () => false,
    send: async (text) => ({ report: `echo:${text}`, cursor: 1, status: "done" as const }),
    readSince: async () => ({ text: "", cursor: 1, idle: true }),
    applyControls: async () => [],
    interrupt: async () => {},
    close: async () => {},
  };
}

const backend: TerminalBackend = {
  kind: "tmux",
  spawn: async (opts) => {
    spawnCalls.push(opts);
    return fakeTerminal(opts.name);
  },
  attachExisting: async () => undefined,
  exists: async () => false,
  engineTagOf: async () => undefined,
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: () => {}, chmodSync: () => undefined, mkdirSync: () => undefined };
});

vi.mock("../bridge/terminal-backend.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bridge/terminal-backend.ts")>();
  return { ...actual, terminalBackend: backend };
});

const { routeForTest } = await import("../bridge/router.ts");
const { registerLive, unregisterLive } = await import("../bridge/sessions.ts");
const {
  DEFAULT_CLAUDE_MODEL,
  FABLE_ALIAS,
  FABLE_CONSENT_FIELD,
  FABLE_FULL_MODEL_ID,
  isFableModel,
  resolveOpenModel,
  resolveTurnModel,
  FableConsentRequiredError,
  FableConsentMalformedError,
} = await import("../bridge/model-policy.ts");

const opened: string[] = [];
afterEach(() => {
  for (const name of opened.splice(0)) unregisterLive(name);
  spawnCalls.length = 0;
});

let counter = 0;
const uniqueName = (prefix: string) => `${prefix}-${(counter += 1)}`;

async function open(body: Record<string, unknown>) {
  const name = String(body.name);
  opened.push(name);
  return routeForTest("POST", "/sessions/open", body);
}

/** A live Claude session whose per-turn controls we can observe. */
function seedLiveClaude(name: string, sent: Array<{ model?: string; effort?: string }>): void {
  const session: DrivableSession = {
    id: name,
    engine: "claude" as EngineId,
    cwd: "/tmp",
    isAlive: async () => true,
    isWorking: async () => false,
    send: async (_text, controls) => {
      sent.push({ model: controls?.model, effort: controls?.effort });
      return { status: "done", report: "ok", cursor: 1 };
    },
    read: async () => ({ text: "", cursor: 0, idle: true }),
    interrupt: async () => {},
    close: async () => {},
    attachHint: () => "fake-attach-hint",
  };
  registerLive(session);
  opened.push(name);
}

describe("default model: a new Claude session opened without a model gets Opus", () => {
  it("passes model \"opus\" to spawn when the caller names no model", async () => {
    const name = uniqueName("default-model");
    const res = await open({ name });
    expect(res.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.model).toBe("opus");
    expect(DEFAULT_CLAUDE_MODEL).toBe("opus");
  });

  it("does not override an explicit model", async () => {
    const name = uniqueName("explicit-sonnet");
    const res = await open({ name, model: "sonnet" });
    expect(res.status).toBe(200);
    expect(spawnCalls[0]!.model).toBe("sonnet");
  });

  it("normalizes an explicit alias rather than silently passing raw input through", async () => {
    const name = uniqueName("explicit-upper");
    const res = await open({ name, model: "HAIKU" });
    expect(res.status).toBe(200);
    expect(spawnCalls[0]!.model).toBe("haiku");
  });

  it("still rejects an unsupported model instead of falling back to the default", async () => {
    const name = uniqueName("bad-model");
    const res = await open({ name, model: "gpt-4" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/unsupported model/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("applies NO default to a per-turn override (an omitted per-turn model keeps the session's model)", async () => {
    const name = uniqueName("no-turn-default");
    const sent: Array<{ model?: string; effort?: string }> = [];
    seedLiveClaude(name, sent);
    const res = await routeForTest("POST", `/sessions/${name}/send`, { text: "go" });
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ model: undefined, effort: undefined }]);
  });
});

describe("Fable is explicit-user-only: open_session", () => {
  for (const model of [FABLE_ALIAS, FABLE_FULL_MODEL_ID, "CLAUDE-FABLE-5", "claude-fable-5[1m]"]) {
    it(`rejects model "${model}" without ${FABLE_CONSENT_FIELD}, before any spawn`, async () => {
      const name = uniqueName("fable-denied");
      const res = await open({ name, model });
      expect(res.status).toBe(400);
      const body = JSON.stringify(res.body);
      expect(body).toMatch(/explicit-user-only/);
      expect(body).toMatch(new RegExp(FABLE_CONSENT_FIELD));
      // Rejected before any side effect, and NOT silently substituted.
      expect(spawnCalls).toHaveLength(0);
    });

    it(`allows model "${model}" with ${FABLE_CONSENT_FIELD}: true`, async () => {
      const name = uniqueName("fable-allowed");
      const res = await open({ name, model, [FABLE_CONSENT_FIELD]: true });
      expect(res.status).toBe(200);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.model?.toLowerCase()).toBe(model.toLowerCase());
    });
  }

  it(`rejects ${FABLE_CONSENT_FIELD}: false as no consent`, async () => {
    const name = uniqueName("fable-false");
    const res = await open({ name, model: FABLE_ALIAS, [FABLE_CONSENT_FIELD]: false });
    expect(res.status).toBe(400);
    expect(spawnCalls).toHaveLength(0);
  });

  it(`rejects a non-boolean ${FABLE_CONSENT_FIELD} rather than treating a truthy value as consent`, async () => {
    const name = uniqueName("fable-string");
    const res = await open({ name, model: FABLE_ALIAS, [FABLE_CONSENT_FIELD]: "true" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/must be a boolean/);
    expect(spawnCalls).toHaveLength(0);
  });

  it(`does not let ${FABLE_CONSENT_FIELD} change a non-Fable model`, async () => {
    const name = uniqueName("consent-noop");
    const res = await open({ name, model: "sonnet", [FABLE_CONSENT_FIELD]: true });
    expect(res.status).toBe(200);
    expect(spawnCalls[0]!.model).toBe("sonnet");
  });

  it("never auto-selects Fable: the default with no model is Opus, not Fable", async () => {
    const name = uniqueName("never-auto");
    await open({ name });
    expect(spawnCalls[0]!.model).toBe("opus");
    expect(isFableModel(spawnCalls[0]!.model!)).toBe(false);
  });
});

describe("Fable is explicit-user-only: per-turn model override", () => {
  for (const model of [FABLE_ALIAS, FABLE_FULL_MODEL_ID]) {
    it(`rejects a per-turn "${model}" override without ${FABLE_CONSENT_FIELD}, and sends nothing`, async () => {
      const name = uniqueName("turn-fable-denied");
      const sent: Array<{ model?: string; effort?: string }> = [];
      seedLiveClaude(name, sent);
      const res = await routeForTest("POST", `/sessions/${name}/send`, { text: "go", model });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/explicit-user-only/);
      // The instruction must NOT have been delivered on a rejected turn.
      expect(sent).toHaveLength(0);
    });

    it(`allows a per-turn "${model}" override with ${FABLE_CONSENT_FIELD}: true`, async () => {
      const name = uniqueName("turn-fable-allowed");
      const sent: Array<{ model?: string; effort?: string }> = [];
      seedLiveClaude(name, sent);
      const res = await routeForTest("POST", `/sessions/${name}/send`, {
        text: "go",
        model,
        [FABLE_CONSENT_FIELD]: true,
      });
      expect(res.status).toBe(200);
      expect(sent).toEqual([{ model, effort: undefined }]);
    });
  }

  it("keeps the gate on the send path so open_session's guard cannot be stepped around a turn later", async () => {
    const name = uniqueName("no-step-around");
    const sent: Array<{ model?: string; effort?: string }> = [];
    seedLiveClaude(name, sent);
    // Session opened on the default model, then an un-consented Fable turn.
    const res = await routeForTest("POST", `/sessions/${name}/send`, { text: "go", model: FABLE_ALIAS });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("model-policy unit behavior", () => {
  it("recognizes the alias and full ids as Fable, case-insensitively", () => {
    expect(isFableModel("fable")).toBe(true);
    expect(isFableModel("FABLE")).toBe(true);
    expect(isFableModel("claude-fable-5")).toBe(true);
    expect(isFableModel("Claude-Fable-5[1m]")).toBe(true);
  });

  it("does not sweep in unrelated models by prefix", () => {
    expect(isFableModel("opus")).toBe(false);
    expect(isFableModel("claude-opus-5")).toBe(false);
    expect(isFableModel("claude-fablesomething-5")).toBe(false);
  });

  it("resolveOpenModel defaults to opus and gates Fable", () => {
    expect(resolveOpenModel(undefined, false)).toBe("opus");
    expect(resolveOpenModel("sonnet", false)).toBe("sonnet");
    expect(() => resolveOpenModel("fable", false)).toThrow(FableConsentRequiredError);
    expect(resolveOpenModel("fable", true)).toBe("fable");
  });

  it("resolveTurnModel supplies no default and gates Fable", () => {
    expect(resolveTurnModel(undefined, false)).toBeUndefined();
    expect(resolveTurnModel(undefined, true)).toBeUndefined();
    expect(() => resolveTurnModel(FABLE_FULL_MODEL_ID, false)).toThrow(FableConsentRequiredError);
    expect(resolveTurnModel(FABLE_FULL_MODEL_ID, true)).toBe(FABLE_FULL_MODEL_ID);
  });

  it("readFableConsent rejects non-booleans", async () => {
    const { readFableConsent } = await import("../bridge/model-policy.ts");
    expect(readFableConsent(undefined)).toBe(false);
    expect(readFableConsent(true)).toBe(true);
    expect(() => readFableConsent("true")).toThrow(FableConsentMalformedError);
    expect(() => readFableConsent(1)).toThrow(FableConsentMalformedError);
  });
});
