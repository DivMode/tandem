/**
 * orchestration-policy.ts — the ONE canonical statement of how a connected
 * client is expected to drive Tandem.
 *
 * WHY ONE MODULE. The same policy has to reach a client three ways: as the
 * MCP `initialize` result's `instructions` (server-level, read once at
 * connect), as concise per-tool guidance inside tool descriptions (read every
 * time the model considers a tool), and as the full versioned document served
 * by the `get_orchestration_policy` tool (read on demand). Three hand-written
 * copies of the same rules would disagree within a release. Everything below
 * derives from ORCHESTRATION_POLICY, and the model-routing half derives from
 * bridge/model-policy.ts — the module that actually ENFORCES it — so the text
 * a client is told and the behavior the router implements cannot drift.
 *
 * STATUS OF `instructions` (MCP spec): InitializeResult.instructions is a HINT
 * for client consumption. The spec says it "can be used by clients to improve
 * the LLM's understanding" — a client MAY use it, add it to a system prompt,
 * or ignore it entirely. Nothing here is enforced by virtue of being in the
 * instructions string. The rules that MUST hold are enforced in the router
 * (bridge/router.ts + bridge/model-policy.ts) and fail closed there regardless
 * of whether any client ever read a word of this.
 */
import {
  DEFAULT_CLAUDE_MODEL,
  FABLE_ALIAS,
  FABLE_CONSENT_FIELD,
  FABLE_FULL_MODEL_ID,
} from "../bridge/model-policy.ts";

/** Bump on any change to the policy text or rules below. */
export const ORCHESTRATION_POLICY_VERSION = "1.1.0";

export interface OrchestrationPolicy {
  readonly version: string;
  readonly roles: readonly { readonly actor: string; readonly role: string }[];
  readonly sessionDiscipline: readonly string[];
  readonly interruptionModel: readonly string[];
  readonly pollingProtocol: readonly string[];
  readonly reconciliation: readonly string[];
  readonly modelRouting: {
    readonly defaultModel: string;
    readonly rules: readonly string[];
    readonly fable: {
      readonly alias: string;
      readonly fullModelId: string;
      readonly consentField: string;
      readonly rules: readonly string[];
    };
  };
}

export const ORCHESTRATION_POLICY: OrchestrationPolicy = {
  version: ORCHESTRATION_POLICY_VERSION,
  roles: [
    {
      actor: "ChatGPT (the connected client)",
      role:
        "Foreman. Plans the work, splits it, delegates it to Tandem workers, reviews what comes back, and decides what happens next. The foreman does not do the engineering itself — it drives the workers that do.",
    },
    {
      actor: "GitHub",
      role:
        "Durable truth. Branches, commits, pull requests, issues, reviews, and CI results are the record of the work. Anything that must outlive this conversation belongs there, not in a chat transcript and not in a worker's scrollback.",
    },
    {
      actor: "Tandem (this server)",
      role:
        "Execution and session bus. It owns the live interactive engine sessions on real machines and is the only route to them. It is a bus, not a memory: it holds running work, not the project's history.",
    },
  ],
  sessionDiscipline: [
    "Call list_sessions BEFORE open_session. A worker you started earlier is very likely still alive and still holding the context you need.",
    "Reuse a matching live session instead of opening a second one. Duplicate workers on the same task diverge, fight over the same files, and waste the machine.",
    "open_session is idempotent for a name that is already live: it returns the existing session with reused: true rather than starting a second engine. Use a stable, descriptive name per unit of work so reuse actually happens.",
    "Preserve a returned \"<deviceId>:<localName>\" name exactly. That composite name is what pins later calls to the same worker on the same device; a bare name always means local and will route somewhere else.",
    "Close a session when its work is genuinely finished, not between turns.",
  ],
  interruptionModel: [
    "Interrupting ChatGPT does NOT stop in-flight Tandem work. The worker is a separate process on a real machine; stopping the conversation only stops the foreman's side of it. The turn keeps running.",
    "So after any interruption, disconnect, new conversation, or client restart: call list_sessions first and resume the SAME worker. Do not assume the work died with the conversation.",
    "Never open a fresh session to \"restart\" work that was already in flight — you will end up with two workers doing the same job.",
    "interrupt_session is the ONLY thing that stops a running turn. Use it deliberately, for a genuinely runaway turn; the session stays open afterwards and can be driven again.",
  ],
  pollingProtocol: [
    "send_to_session waits up to a bounded timeout. status \"running\" plus a cursor means the turn is STILL EXECUTING — it does not mean the instruction was lost.",
    "On status \"running\", poll the SAME session with empty text and that cursor. Empty text reads only newer output; it does not start a new turn.",
    "NEVER resend the instruction to a running session. A resend queues a second instruction into a live turn and corrupts the worker's state.",
    "Keep polling with the newest returned cursor until the result reports idle/done. Polling is cheap; a duplicated instruction is not.",
  ],
  reconciliation: [
    "Tandem work finishes whether or not a foreman is connected. Every real lifecycle transition — a turn completed, a worker blocked or asking a question, a turn interrupted, a session closed, a send that errored — is written to a durable local feed on the host.",
    "At the START of substantial engineering work, and again after ANY interruption, reconnect, new conversation, or context loss: call list_sessions AND get_foreman_events, before opening anything.",
    "get_foreman_events is HISTORY: it says what happened. list_sessions is LIVENESS: it says what is running right now. A `completed` event does NOT mean the worker exited, and the absence of an event does NOT mean nothing happened. Never decide whether to open a session from the event feed alone.",
    "Carry the `checkpoint` the tool returns and pass it back as `since` on your next call, so you see each transition once. Tandem does not track what you have read: the transport is stateless and has no per-conversation identity, so the checkpoint lives with you, not on the server.",
    "`more: true` is pagination — unread events remain, so call again with the returned checkpoint. `truncated: true` is loss — events you never saw were dropped by retention, or your checkpoint predates the current store — so reconcile against list_sessions rather than assuming a full record.",
    "Each device keeps its own events, recorded where the work ran. Omit `device` for the hub; to cover a fleet, call list_devices and then get_foreman_events once per device. One call never reads more than one device, and an offline device is reported explicitly rather than looking like silence.",
    "This feed is the reconciliation mechanism BECAUSE no MCP server can wake a dormant conversation. Nothing Tandem does will make a chat client resume on its own; you must ask on your next turn.",
  ],
  modelRouting: {
    defaultModel: DEFAULT_CLAUDE_MODEL,
    rules: [
      `New Claude sessions default to the "${DEFAULT_CLAUDE_MODEL}" alias (Opus 5). Omit model to get it; the server applies the default, so there is nothing to remember.`,
      `The "default" alias resolves to "${DEFAULT_CLAUDE_MODEL}" as well. It does NOT mean "whatever the host's CLI is configured for" — this server never emits a model whose meaning it cannot see.`,
      "Choose sonnet deliberately for a narrow, read-only, or mechanical helper — a lookup, a summary of known output, a rote edit under an already-decided plan.",
      "haiku is for trivial or exceptional cases only; it is not a default and not a cost-saving reflex for real engineering work.",
      "When the task is real engineering — design, debugging, multi-file change, review — leave it on the default.",
    ],
    fable: {
      alias: FABLE_ALIAS,
      fullModelId: FABLE_FULL_MODEL_ID,
      consentField: FABLE_CONSENT_FIELD,
      rules: [
        `Fable is EXPLICIT-USER-ONLY. Never select "${FABLE_ALIAS}" or "${FABLE_FULL_MODEL_ID}" on your own initiative, for any reason, however well it seems to fit.`,
        `Requesting Fable requires ${FABLE_CONSENT_FIELD}: true on the same open_session or send_to_session call.`,
        `Set ${FABLE_CONSENT_FIELD}: true ONLY when the user's CURRENT instruction explicitly asked for Fable. Never infer it from earlier turns, from a stored preference, from the task's shape, or from your own judgement.`,
        `Without ${FABLE_CONSENT_FIELD}: true the request is rejected with a 400. The server never silently substitutes a different model, so a rejection means: ask the user, or pick a non-Fable model yourself.`,
      ],
    },
  },
};

const bullets = (lines: readonly string[]): string => lines.map((l) => `- ${l}`).join("\n");

/**
 * The `initialize` result's instructions string. Deliberately compact: it is a
 * client-consumption hint that may be pasted into a system prompt, so it
 * carries the rules that change what a client DOES, and defers the full
 * document to the get_orchestration_policy tool.
 */
export const ORCHESTRATION_INSTRUCTIONS = [
  `Tandem orchestration policy v${ORCHESTRATION_POLICY.version}.`,
  "",
  "ROLES",
  bullets(ORCHESTRATION_POLICY.roles.map((r) => `${r.actor}: ${r.role}`)),
  "",
  "SESSIONS — list and reuse before you open",
  bullets(ORCHESTRATION_POLICY.sessionDiscipline),
  "",
  "INTERRUPTION — stopping the conversation does not stop the worker",
  bullets(ORCHESTRATION_POLICY.interruptionModel),
  "",
  "POLLING — running + cursor means poll, never resend",
  bullets(ORCHESTRATION_POLICY.pollingProtocol),
  "",
  "RECONCILE — events are history, list_sessions is liveness",
  bullets([
    "Starting substantial engineering work, or resuming after any interruption, reconnect, or context loss: call list_sessions AND get_foreman_events (passing your last checkpoint as `since`) BEFORE opening anything.",
    "get_foreman_events reports what happened while you were away; list_sessions is the only truth about what is still running. Never treat an event as proof a worker is or is not alive.",
    "Keep the returned `checkpoint` and pass it back next time — the server does not remember what you have read.",
    "No MCP server can wake a dormant conversation, so this reconciliation on your next turn is the mechanism, not a fallback.",
  ]),
  "",
  "MODEL ROUTING",
  bullets(ORCHESTRATION_POLICY.modelRouting.rules),
  bullets(ORCHESTRATION_POLICY.modelRouting.fable.rules),
  "",
  "Call get_orchestration_policy for the full versioned policy. These instructions are a hint; the session, polling, and model-routing rules above are enforced by the server regardless.",
].join("\n");

/* ---- concise snippets for tool descriptions --------------------------------
 * Short on purpose. A tool description is read on every tool-selection
 * decision, so each snippet states only the rule that changes what THIS tool
 * call should be, and leaves the reasoning to the policy above. */

export const TOOL_GUIDANCE = {
  listSessions:
    "ORCHESTRATION: call this BEFORE open_session and reuse a matching live worker instead of opening a duplicate. Call it again first thing after any interruption, reconnect, or new conversation — in-flight Tandem work survives the client stopping, so resume the same worker rather than starting a second one.",
  openSession:
    `ORCHESTRATION: list_sessions first and reuse a live worker; a name already live is returned with reused: true rather than opened twice. MODEL: omit model to get the "${DEFAULT_CLAUDE_MODEL}" default (Opus 5) for real engineering work; pick sonnet deliberately for narrow, read-only, or mechanical helpers; haiku only for trivial cases.`,
  sendToSession:
    'ORCHESTRATION: status "running" with a cursor means the turn is STILL EXECUTING — poll the same session with empty text and that cursor. NEVER resend the instruction to a running session; a resend queues a second instruction into a live turn. Interrupting the client does not stop this turn.',
  fableParam:
    `Set true ONLY when the user's current instruction explicitly requested Fable. Never infer it — not from earlier turns, a stored preference, the task's shape, or your own judgement. Required for the "${FABLE_ALIAS}" alias or a "${FABLE_FULL_MODEL_ID}" id; without it the call is rejected (400) and no model is substituted.`,
  foremanEvents:
    "ORCHESTRATION: call this together with list_sessions when you start substantial engineering work and after any interruption, reconnect, or context loss — before opening a session, so you do not duplicate a worker whose result is already here. This is HISTORY, not liveness: list_sessions says what is running now. Pass the previous call's `checkpoint` as `since` to see each transition once; the server does not track what you have read.",
  policyTool:
    `Read-only. Returns the full versioned Tandem orchestration policy (v${ORCHESTRATION_POLICY_VERSION}): roles (client = foreman, GitHub = durable truth, Tandem = execution/session bus), session reuse discipline, the interruption model, the running/cursor polling protocol, and model routing including the explicit-user-only Fable rule. Opens nothing, changes nothing, and touches no session. The same policy is offered as the MCP initialize instructions; call this when those were not surfaced or when you need the full text.`,
} as const;
