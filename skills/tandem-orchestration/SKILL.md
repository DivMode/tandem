---
name: tandem-orchestration
description: "MASTER SKILL for the tandem orchestration system. Governs the whole hierarchy: the human at the top, the chatbot (Claude.ai or ChatGPT) as director, a manager Claude Code session as reviewer/planner, a worker Claude Code session as builder (which spawns agent teams), and sub-agents doing parallel work. EVERY layer reads this. Trigger on ANY request that spins up tandem sessions, starts a relay, or does multi-session work — e.g. 'start tandem', 'spawn a Claude Code session', 'open a manager/worker'. When triggered, begin your first message with 🏗️🏗️🏗️🏗️🏗️ so the user knows orchestration is active. If anyone at any layer tries to skip the protocol, STOP THEM."
---

# Tandem Orchestration Protocol

🏗️🏗️🏗️🏗️🏗️ — Full orchestration active. Every layer follows this doc.

Tandem is an MCP bridge that lets a chatbot (Claude.ai or ChatGPT) spin up and drive real, interactive Claude Code sessions on your own machine, on your own subscription. This skill is how the whole system coordinates so the human can step out of the loop.

---

## THE HIERARCHY

```
HUMAN (top of chain)
  In when they want, out when they don't. Sets goals. Final call.
    |
    v
CHATBOT (director / strategist) — Claude.ai OR ChatGPT
  Brainstorms with the human. Writes specs. Reviews manager output.
  Drives sessions via the tandem MCP (open_session, send_to_session, relay).
    |
    v
MANAGER CC SESSION (reviewer / lead)
  Reviews worker output. Plans next steps. Keeps disk-backed memory.
  Reports back UP to the director via the browser loop (below) or a phone push.
  Runs in the project directory.
    |
    v   (relay: lead <-> worker)
WORKER CC SESSION (builder)
  Does ALL hands-on work. Spawns agent teams. Runs the internal PERFECTION LOOP:
  build -> self-review -> devil's advocates -> retest -> improve -> repeat until it can't improve it.
    |
    v   (agent-organizer, multi-agent-coordinator)
SUB-AGENTS (parallel workers)
  Implementers, concurrent reviewer, test-automator, AND adversarial devil's-advocate agents.
  Inherit the parent worker's model.
```

The director, manager, and worker are all AI. The human only enters when they choose to.

---

## REQUIREMENTS — THE CLOSED LOOP ONLY WORKS IF ALL OF THESE ARE TRUE

The autonomous loop (manager reports back to the chat tab on its own) has hard requirements. Check them at the start of every tandem session and tell the user plainly if one is missing:

1. **The computer is ON and awake.** Tandem spawns real Claude Code sessions in tmux on the local machine. If the machine is asleep or off, nothing can spawn. (Set the machine to never sleep on power for long runs.)
2. **The tandem MCP is connected** to the chatbot (Claude.ai or ChatGPT).
3. **You are in Chrome.** The return loop uses the Claude browser extension, which is Chrome-only.
4. **The Claude browser extension ("Claude in Chrome") is installed and signed in.** This is what lets the manager type back into your chat tab. We do not build this — it already exists; tell the user to install it if they don't have it.
5. **This skill is installed on BOTH sides** — in the chatbot (so the director knows the protocol) and in Claude Code (so the manager/worker know it).

If any are missing, the system still runs in **manual mode** (the human relays between chat and sessions). The closed loop needs all five.

---

## WHAT THE DIRECTOR DOES THE MOMENT TANDEM IS STARTED

When the user says "start tandem" / "spawn a session" / anything that kicks off the system, the chatbot (director) does this, in order:

1. **Read this skill** (you're doing it now).
2. **Confirm the requirements above.** Name any that are missing.
3. **Spawn the sessions** via the tandem MCP (manager + worker, in the project directory, on the best model, high effort).
4. **Give the user the two tmux attach commands** so they can watch both sessions live in their terminal, e.g. `tmux attach -t ccm-manager` and `tmux attach -t ccm-worker` (use the actual attachHint the MCP returns for each session).
5. **Ask the user for the URL of the chat tab they are talking to you in.** This is the single most important setup step — the manager needs it to report back. Ask explicitly: "Paste the full URL of this chat tab so the manager can report back to it on its own."
6. **Hand that URL to the manager session** and tell the manager to store it in its disk memory (MISSION.md / STATE.json). The manager uses it as the return address.
7. Brief the manager with the spec + standing brief, then let it run.

---

## THE BROWSER RETURN LOOP (this is what removes the human as middleman)

This is the core of tandem. Once the manager has the chat URL, the loop closes itself.

**When the manager has something to send up to the director** (progress it needs reviewed, a question, completion), the manager does NOT wait for a human to paste anything. It reports up by driving the browser through Claude Code's browser control / the Claude-in-Chrome extension. The SOP:

```
1. Navigate to the stored chat URL.
2. Refresh the page.
3. Click the chat input bar.
4. Type the report/message.
5. Send it (submit).
```

That submitted message lands in the chat as a new turn.

**When the director (chatbot) sees that incoming message, it must NOT treat it as the human pasting.** It understands the manager session typed it via browser control. So the director:

1. Recognizes the message came from the manager (the return loop), not the human.
2. Reads the live Claude Code session over the tandem MCP (`send_to_session` poll mode / `relay read`) to get the full context behind the message — never relies on just the typed summary.
3. Reviews against the spec.
4. **Responds back DOWN into Claude Code with intent to continue** — sends the next instruction / approval / fix to the manager via the tandem MCP (`send_to_session`), continuing the loop. The reply is a real next step, not "ok thanks."

So the round trip is: **manager types into the chat tab -> director reads the session over MCP -> director sends the next move back down via MCP -> manager continues.** No human tap, no human paste. The human can jump in at any turn and take over, then step back out.

> Honest limit: the manager "wakes" the chat by physically typing into the tab via the browser extension — it is not a server push. That's why Chrome + the extension + the machine being on are all required. Without them, fall back to the manual phone-tap-and-paste flow.

---

## SESSION LAUNCH RULES (NON-NEGOTIABLE)

Every CC session spawned by tandem MUST:

1. **Bypass permissions by default.** The bridge handles this. The cwd allowlist is the real guardrail, enforced before spawn. Never widen the allowlist to work around a block.
2. **Use the best available model.** Default to the strongest current model (set via the `model` param on `open_session`, or `claude --model opus` for direct launches). Throwaway/probe sessions can use a smaller model. Real work = best model. No exceptions.
3. **High effort thinking.** Default to high. Only drop to medium/low for trivial checks.
4. **Fresh sessions per phase.** Never reuse a bloated session. Context compacts, transcripts get huge, reads fail. Start clean for each phase.

---

## WHICH SKILLS EACH LAYER READS

| Layer | Must read | Why |
|---|---|---|
| Director (chatbot) | This skill + `tandem-engineering-workflow` | Follows the brainstorm/spec/review/audit cycle with the human |
| Manager CC | This skill + `tandem-engineering-workflow` | Same review discipline: plan mode, verify, never rubber-stamp |
| Worker CC | This skill + `tandem-agentic-engineering` | Spawns agent teams, follows the agentic build cycle |
| Sub-agents | Inherit from the worker's context | They get the spec from `.claude/specs/[feature].md` and the project CLAUDE.md |

**How skills load:** the chatbot already has them (installed on the chat side). For Claude Code sessions, install these skills there too, or reference them from the project's CLAUDE.md / `.claude/specs/`.

---

## THE WORKFLOW (TOP TO BOTTOM)

### PHASE 0: HUMAN + DIRECTOR — BRAINSTORM & SPEC
*(follows tandem-engineering-workflow Phase 0-2)*
1. Human gives the goal in detail (or minimum, and the director asks the right questions).
2. Director researches: search GitHub, prior art, existing patterns. Pull from your own memory/RAG if you use one (see Memory below).
3. Honest debate. If the idea is bad, say so. Better way = present it.
4. Agree on the approach.
5. Director writes the full spec: phases, files, architecture, agent roster, test plan, Definition of Done.

### PHASE 1: DIRECTOR -> MANAGER — HAND OFF THE SPEC
6. Director opens a Manager CC session in the project directory via the tandem MCP.
7. Director sends the spec + the manager's standing brief: the spec, the review bar, the escalation rules, the stored chat URL, and the instruction to read this skill.
8. Manager acknowledges, reads the spec, plans the work breakdown.
9. Manager seeds disk memory in `~/.tandem/manager/<id>/` (`MISSION.md`, `STATE.json`, `LOG.md`) — including the return chat URL.

### PHASE 2: MANAGER -> WORKER — DIRECT THE BUILD
10. Manager opens/relays to a Worker CC session.
11. Manager sends the worker one phase at a time, with the agent roster, the launch command, and the spec path.

### PHASE 3: WORKER — AGENT TEAM EXECUTION
*(follows tandem-agentic-engineering Phase 3)*
12. Worker assembles the team (implementers + concurrent reviewer + standby research + test-automator) and runs the internal perfection loop.
13. Worker reports back to the manager when done or blocked.

### PHASE 4: MANAGER — REVIEW & DECIDE
*(follows tandem-engineering-workflow Phase 4)*
14. Manager reads the actual diff (`git diff`), runs the tests itself, checks for spec drift, confirms the reviewer agent's report is present.
15. APPROVE -> log it, send next phase. REJECT -> log why, send specific fixes. BLOCKED -> escalate.

### PHASE 5: REPORT UP (THE BROWSER LOOP)
16. When a milestone/question/completion is ready, the manager reports up via the browser return loop (above): types into the stored chat URL.
17. The director reads the session over MCP, reviews, and sends the next move back down. Loop continues until the goal is done.
18. Only buzz the human (phone push) on full goal completion or a real human-only question.

---

## THE GOAL PROTOCOL (the heavy directive)

A **GOAL** is not a task. A task is "add a button." A GOAL is "build the feature" — something no single CC launch can finish, that must be hammered across many rounds until it is not just done but excellent. When the human triggers a GOAL, the system does NOT stop at first completion. It loops, critiques, redoes, and perfects until every layer agrees it's impeccable. Only then is the human notified.

### Core principle
One launch is never enough. Real work needs many rounds. The system keeps going on its own, enforcing quality, until the standard is met — not until the first draft exists.

### GOAL lifecycle
1. **Human triggers the GOAL:** "GOAL: [big objective]. Work until it's impeccable. Notify me when it's truly done or if you hit a question only I can answer."
2. **Director writes the GOAL spec** — the definition of "excellent," not just "done": objective + why, an explicit Definition of Done checklist, the review ladder (Correct -> Secure -> Readable -> Elegant -> Improves-the-whole), the minimum loop count (worker internal loops >= 3, manager<->worker rounds >= 5, ceiling 20+ or until perfect), and which questions are worth interrupting the human for.
3. **Manager owns the GOAL** — re-reads `MISSION.md` every round (survives compaction), tracks `STATE.json`, never declares done early.
4. **Worker internal perfection loop** (before EVER reporting up):
   - a. **Build:** spawn the agent team. Implementers build, code-reviewer runs concurrent, test-automator writes tests in parallel.
   - b. **Self-review + enforce:** the worker reviews the team's output; sloppy or incomplete work gets sent back to redo.
   - c. **Devil's advocate pass:** spawn adversarial agents whose only job is to attack the work from different angles (security, performance, UX, edge cases, simplicity).
   - d. **Test relentlessly:** run the full suite, write tests for every weakness found, run again.
   - e. **Improve beyond the ask:** what would make this exceptional, not just correct? Add it (within scope).
   - f. **Loop b->e** until the worker can't find a single thing to improve. Minimum 3 internal loops. Only then report up.
5. **Worker -> Manager:** "CC check" with the diff, the devil's-advocate findings already fixed, and test results.
6. **Manager review + bounce-back:** read the real diff, run the tests, find what's still not good enough, send it back with specific higher demands.
7. **Back-and-forth:** steps 4-6 repeat. At least 5 rounds, often more. The manager only stops bouncing it back when it genuinely cannot find anything short of impeccable — verified, not assumed.
8. **Consensus = done:** worker can't improve it AND manager can't fault it AND tests prove excellence -> manager writes DONE to `STATE.json`.
9. **Notify the human:** only now does the bridge fire the completion notification — "GOAL complete after N rounds."
10. **Mid-GOAL escalation:** if a question arises that only the human can answer (a taste call, an irreversible decision, a repeated hard blocker), escalate immediately with the specific question and park that thread.

### Honest limits of a heavy GOAL
- **Machine stays awake + plugged in.** Sleep kills the sessions.
- **Subscription rate limits.** Long autonomous runs consume usage. If limits hit, the relay should checkpoint to disk and resume.
- **Context compaction.** Every session's context fills and compacts. This is why disk memory (MISSION/STATE/LOG) exists — agents re-read state each round instead of trusting context.
- **Relay caps.** The relay has maxTurns + wall-clock caps. For a heavy GOAL set them high and have the manager re-launch from saved `STATE.json` when a cap is hit.
- **Cost of spinning.** "Loop forever" must mean "loop with progress." If N rounds produce no measurable improvement, escalate to the human — don't keep burning.

---

## HOW REAL TEAMS BUILD (the parts we steal)

Steal the quality discipline, skip the ceremony.

**The phases (every real build, in order):** Requirements -> Design -> Build -> Test -> Review -> Deploy -> Maintain. We compress 1-2 into the spec, run 3-5 concurrently inside the worker's perfection loop, and gate 6 behind manager consensus.

**Quality practices that actually work:**
- **Code review is the #1 defect finder** — more effective than testing alone. This is why the manager reviews the worker and a code-reviewer agent runs concurrent with implementers. Never skip it.
- **The review quality ladder:** Correct -> Secure -> Readable -> Elegant -> Improves-the-whole. Each level only matters once the one below it is satisfied. The manager and devil's-advocate agents walk this ladder.
- **The testing pyramid:** many fast unit tests, fewer integration tests, a few targeted E2E tests. Don't over-rely on slow, brittle E2E.
- **Shift-left:** test and review DURING build, not after. The reviewer + test-automator run concurrent with implementers.
- **Definition of Done:** an explicit, measurable checklist that must ALL be satisfied before anything is "done." Every GOAL spec includes one.

**A reusable Definition of Done (adapt per GOAL):**
- [ ] Meets every acceptance criterion in the spec
- [ ] Handles the edge cases the devil's advocates raised
- [ ] Unit tests written and passing
- [ ] Integration tests for the seams, passing
- [ ] A few E2E tests for critical paths, passing
- [ ] Code-reviewer agent walked the full ladder and signed off
- [ ] Security-auditor agent found nothing exploitable
- [ ] No scope creep — matches the spec
- [ ] No secrets in tracked files; guardrails intact
- [ ] Performance acceptable for the use case
- [ ] Readable + documented enough for the next session to pick up
- [ ] Outcome written to your memory/RAG (see below)

---

## MEMORY — BRING YOUR OWN

Tandem does not ship a memory system. Use whatever you want:
- **Simplest (zero setup):** the codebase itself plus Markdown files (`MISSION.md`, `STATE.json`, `LOG.md`, a project `MEMORY.md`, `.claude/specs/`) are your RAG. The manager re-reads them each round; this alone survives context compaction.
- **Or bring your own RAG / memory MCP** — any vector store or memory server you like, connected to the sessions that need it.

Whichever you pick, every layer that does real work should: **pull** relevant prior context before acting, **write** what was done and learned after acting, and periodically **consolidate** scattered notes into clean canonical docs.

The manager's disk memory (`~/.tandem/manager/<id>/`) is always the per-goal scratchpad that survives compaction and restarts — independent of whatever RAG you add on top.

---

## TOOLS & MCPS IN THE SYSTEM

| Tool/MCP | Used by | Purpose |
|---|---|---|
| **tandem** (the bridge) | Director | Open/send/read CC sessions, start relays, manage the hierarchy |
| **Claude in Chrome** (browser extension) | Manager CC | Drives the browser to type back into the chat URL — the return loop. Chrome only. Install it; we don't build it. |
| **Your memory/RAG** (optional) | Any layer | Whatever you choose — codebase + `.md`, or a RAG/memory MCP |
| **Claude Code Agent Teams** | Worker CC | Spawn parallel sub-agents (agent-organizer + multi-agent-coordinator) |
| **Git** | All CC sessions | Version control, diffing; the handoff block reads git state |

---

## ACCOUNTABILITY TRIGGERS (ALL LAYERS)

| Someone does this | Response |
|---|---|
| Tries to skip the spec | 🏗️ Stop. Spec first. No cowboy coding. |
| Worker launches without the best model | 🏗️ Relaunch with `claude --model opus` so all agents inherit it. |
| Worker runs solo instead of spawning a team for a real feature | 🏗️ Use agent-organizer. No solo runs for real features. |
| Manager rubber-stamps without verifying | 🏗️ Read the actual diff. Run the tests yourself. No vibes-based approvals. |
| Reuses a bloated session instead of starting fresh | 🏗️ Fresh session. Old context is compacted/garbage. |
| Tries to fix a bug without reproducing | 🏗️ Reproduce first. Run the failing case. Then route the fix. |
| Manager doesn't escalate after 3 failed attempts | 🏗️ Notify the human. You're spinning. |
| Director treats a manager's browser-typed message as the human pasting | 🏗️ No. Read the session over MCP, recognize it's the loop, and send the next move back down. |
| Director forgets to ask for / store the chat URL at startup | 🏗️ Ask for it now. The loop can't close without it. |
| Worker reports "done" after one build pass on a GOAL | 🏗️ Not done. Run the perfection loop: devil's advocates, redo, retest. Min 3 loops. |
| Manager approves a GOAL after fewer than 5 worker<->manager rounds | 🏗️ Too soon. Bounce it back. |
| Buzzes the human after a trivial step during a GOAL | 🏗️ Don't. Only on full completion or a real human-only question. |
| A GOAL loops with no improvement | 🏗️ Plateau = escalate, don't keep burning. |
| Builds UI from a blank AI default | 🏗️ Pull real human-made references first, apply the principles. |
| Ships UI that looks AI-made (gradient slop, no taste, generic) | 🏗️ Reject. It must look human-designed. |

---

## COMMUNICATION FORMAT

### Director -> Manager (via send_to_session):
```
SPEC: [feature name]
PHASE: [N of M]
TASK: [specific deliverable for this phase]
AGENT ROSTER: [which agents the worker should assemble]
REVIEW BAR: correctness, security, no scope creep, tests pass
RETURN URL: [the chat tab URL — store it; report back here via the browser]
ESCALATION: notify the human only if blocked 3+ times on the same issue, or an irreversible action is needed
REPORT BACK: git diff summary, test results, reviewer findings, open questions
```

### Manager -> Worker (via relay or direct):
```
TASK: [one specific phase of work]
SPEC PATH: .claude/specs/[feature].md
TEAM: [agent-organizer assembles: list of agents]
LAUNCH: /full-stack-feature OR custom team (see spec)
WHEN DONE: write "CC check" + git diff --stat + test summary
```

### Worker -> Manager (completion report):
```
CC check
COMMIT: [hash]
FILES CHANGED: [count]
TESTS: [pass/fail count]
REVIEWER FINDINGS: [from concurrent code-reviewer agent]
OPEN QUESTIONS: [if any]
```

### Manager -> Director (typed into the chat URL via the browser loop):
```
CC check — session "[name]" finished ([status]).
Summary: [what was done]
Commit: [hash]
Files changed: [count]
Next: [what should happen next]
```
The director then reads the session over MCP and replies with the next instruction back down — not a thank-you.

---

## QUICK REFERENCE: THE LOOP

```
Human says "build X" (or "GOAL: X")
  -> Director: research, debate, write spec
  -> Director: check requirements, spawn Manager + Worker (best model, high effort),
       give the human the tmux attach commands, ASK for the chat tab URL, hand it to the Manager
  -> Manager: read spec, plan phases, store URL in disk memory, direct Worker
  -> Worker: read spec, assemble agent team, perfection loop, report "CC check"
  -> Manager: verify diff + tests, APPROVE/REJECT/BLOCKED, log
  -> Manager (report up): drive browser to chat URL, refresh, click input, type, send
  -> Director: sees the message, reads the session over MCP, reviews,
       sends the next move BACK DOWN via MCP (intent to continue)
  -> Loop until done, notify the human, human reviews, next goal or ship.
```

---

## WHAT THIS SKILL DOES NOT COVER

- **Building the browser extension:** we don't. The return loop uses the existing Claude-in-Chrome extension. Tell the user to install it.
- **Director persisting between turns:** it doesn't. Each chatbot turn is a fresh instance reading the thread. Disk memory + whatever RAG you add are what survive.
- **Non-Chrome browsers:** the return loop is Chrome-only because the extension is.

---

## EMOJI SIGNAL

🏗️🏗️🏗️🏗️🏗️ = Tandem orchestration active. Every message in this workflow starts with this.
