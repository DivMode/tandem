---
name: tandem-orchestration
description: "MASTER SKILL for the tandem orchestration system. Governs the whole hierarchy: the human at top, the chatbot (Claude.ai or ChatGPT) as director, a manager Claude Code session as reviewer/planner, a worker Claude Code session as builder (which spawns agent teams), and sub-agents doing parallel work. EVERY layer reads this. Trigger on ANY request that spins up tandem sessions, starts a relay, or does multi-session work — 'start tandem', 'spawn a Claude Code session', 'open a manager/worker'. Begin your first message with the construction signal so the user knows orchestration is active. If anyone at any layer tries to skip the protocol, STOP THEM."
---

# Tandem Orchestration Protocol

Tandem is an MCP bridge that lets a chatbot (Claude.ai or ChatGPT) spin up and drive real, interactive Claude Code sessions on your own machine, on your own subscription. This skill is how the whole system coordinates so the human can step out of the loop.

## THE HIERARCHY
- HUMAN — sets goals, makes final calls, in when they want, out when they don't.
- DIRECTOR (chatbot: Claude.ai or ChatGPT) — brainstorms with the human, writes specs, reviews manager output, drives sessions via the tandem MCP.
- MANAGER CC SESSION — owns the build: plans phases, reviews the worker, keeps disk-backed memory, reports back UP to the director via the browser loop (below). Runs in the project directory.
- WORKER CC SESSION — does all hands-on work; spawns agent teams; runs the internal perfection loop. See tandem-agentic-engineering.
- SUB-AGENTS — implementers, concurrent reviewer, test-automator, and adversarial devil's-advocate agents. Inherit the parent worker model.
The director, manager, and worker are all AI. The human only enters when they choose to.

## REQUIREMENTS — THE CLOSED LOOP ONLY WORKS IF ALL FIVE ARE TRUE
Check these at the start of every tandem session and tell the user plainly if one is missing:
1. The computer is ON and awake. Tandem spawns real Claude Code sessions in tmux locally; if the machine sleeps, nothing spawns. Set it to never sleep on power for long runs.
2. The tandem MCP is connected to the chatbot.
3. You are in Chrome. The return loop uses the Claude browser extension, Chrome-only.
4. The Claude browser extension ("Claude in Chrome") is installed and signed in. This is what lets the manager type back into your chat tab. We do not build this — it already exists; tell the user to install it if missing.
5. This skill is installed on BOTH sides — in the chatbot AND in Claude Code.
If any are missing, the system still runs in MANUAL mode (the human relays between chat and sessions). The closed loop needs all five.

## WHAT THE DIRECTOR DOES THE MOMENT TANDEM IS STARTED
When the user says "start tandem" / "spawn a session" / anything that kicks it off, the director does this in order:
1. Read this skill.
2. Confirm the five requirements. Name any that are missing.
3. Spawn the sessions via the tandem MCP (manager + worker, in the project dir, best model, high effort).
4. Give the user the two tmux attach commands so they can watch both sessions live, e.g. "tmux attach -t ccm-manager" and "tmux attach -t ccm-worker" (use the actual attachHint the MCP returns).
5. ASK the user for the URL of the chat tab they are talking to you in. This is the most important setup step. Ask explicitly: "Paste the full URL of this chat tab so the manager can report back to it on its own."
6. Hand that URL to the manager session and tell it to store it in its disk memory (MISSION.md / STATE.json) as the return address.
7. Brief the manager with the spec + standing brief, then let it run.

## THE BROWSER RETURN LOOP (this is what removes the human as middleman)
Once the manager has the chat URL, the loop closes itself.
When the manager has something to send up (progress to review, a question, completion), it does NOT wait for a human to paste. It reports up by driving the browser through Claude Code's browser control / the Claude-in-Chrome extension. SOP:
1. Navigate to the stored chat URL.
2. Refresh the page.
3. Click the chat input bar.
4. Type the report/message.
5. Send it (submit).
When the director sees that incoming message, it must NOT treat it as the human pasting. It understands the manager session typed it via browser control. So the director:
1. Recognizes the message came from the manager (the return loop), not the human.
2. Reads the live Claude Code session over the tandem MCP (send_to_session poll / relay read) to get the full context behind the message — never relies on just the typed summary.
3. Reviews against the spec.
4. Responds back DOWN into Claude Code with intent to continue — sends the next instruction/approval/fix to the manager via the tandem MCP, continuing the loop. The reply is a real next step, not "ok thanks."
Round trip: manager types into the chat tab -> director reads the session over MCP -> director sends the next move back down via MCP -> manager continues. No human tap, no human paste. The human can jump in at any turn and take over, then step back out.
Honest limit: the manager "wakes" the chat by physically typing into the tab via the extension — not a server push. That is why Chrome + the extension + the machine being on are all required. Without them, fall back to the manual phone-tap-and-paste flow.

## SESSION LAUNCH RULES (NON-NEGOTIABLE)
1. Bypass permissions by default (the bridge handles it). The cwd allowlist is the real guardrail, enforced before spawn. Never widen it to work around a block.
2. Use the best available model (model param on open_session, or claude --model opus). Real work = best model. Throwaway sessions can use a smaller model.
3. High effort thinking by default. Drop only for trivial checks.
4. Fresh sessions per phase. Never reuse a bloated, compacted session.

## WHICH SKILLS EACH LAYER READS
- Director: this skill + tandem-engineering-workflow.
- Manager CC: this skill + tandem-engineering-workflow.
- Worker CC: this skill + tandem-agentic-engineering.
- Sub-agents: inherit from the worker's context (spec at .claude/specs/[feature].md + project CLAUDE.md).

## THE WORKFLOW (TOP TO BOTTOM)
PHASE 0 — HUMAN + DIRECTOR brainstorm & spec: research, honest debate, agree, write the full spec (phases, files, architecture, agent roster, test plan, Definition of Done).
PHASE 1 — DIRECTOR -> MANAGER: open a manager session in the project dir; send spec + standing brief + the stored chat URL + instruction to read this skill; manager seeds disk memory in ~/.tandem/manager/<id>/ (MISSION.md, STATE.json, LOG.md) including the return URL.
PHASE 2 — MANAGER -> WORKER: send the worker one phase at a time with the agent roster, launch command, and spec path.
PHASE 3 — WORKER agent-team execution (see tandem-agentic-engineering): assemble team, run the perfection loop, report back done or blocked.
PHASE 4 — MANAGER review & decide: read the actual diff (git diff), run the tests, check for drift, confirm the reviewer agent's report is present. APPROVE/REJECT/BLOCKED, log it.
PHASE 5 — REPORT UP via the browser loop: manager types into the stored chat URL; director reads the session over MCP, reviews, sends the next move back down. Loop until done. Buzz the human only on full completion or a real human-only question.

## THE GOAL PROTOCOL (the heavy directive)
A GOAL is not a task. A task is "add a button." A GOAL is "build the feature" — hammered across many rounds until it is excellent, not just done. The system does not stop at first completion.
1. Human triggers: "GOAL: [objective]. Work until impeccable. Notify me when truly done or if you hit a question only I can answer."
2. Director writes the GOAL spec: objective + why, an explicit Definition of Done checklist, the review ladder (Correct -> Secure -> Readable -> Elegant -> Improves-the-whole), minimum loop counts (worker internal loops >= 3, manager<->worker rounds >= 5, ceiling 20+ or until perfect), and which questions are worth interrupting the human for.
3. Manager owns the GOAL: re-reads MISSION.md every round (survives compaction), tracks STATE.json, never declares done early.
4. Worker internal perfection loop (before reporting up): build with the team (concurrent reviewer + test-automator) -> self-review and send sloppy work back -> devil's-advocate pass (security/performance/UX/edge-cases/simplicity) -> test relentlessly, write tests for every weakness -> improve beyond the ask within scope -> loop until nothing can improve. Minimum 3 loops.
5. Worker -> Manager: "CC check" with the diff, devil's-advocate findings already fixed, test results.
6. Manager review + bounce-back: read the real diff, run the tests, find what is still not good enough, send it back with higher demands.
7. Back-and-forth: steps 4-6 repeat. At least 5 rounds, often more. Stop only when genuinely nothing short of impeccable remains — verified, not assumed.
8. Consensus = done: worker can't improve it AND manager can't fault it AND tests prove excellence -> manager writes DONE.
9. Notify the human only now.
10. Mid-GOAL escalation: a question only the human can answer (taste call, irreversible decision, repeated hard blocker) -> escalate immediately with the specific question, park that thread.
Honest limits: machine stays awake + plugged in; subscription rate limits (checkpoint to disk and resume); context compaction (disk memory is why it survives); relay caps (set high, re-launch from STATE.json when hit); cost of spinning (no measurable improvement across N rounds = escalate, don't keep burning).

## MEMORY — BRING YOUR OWN
Tandem ships no memory system. Use whatever you want:
- Simplest (zero setup): the codebase plus Markdown files (MISSION.md, STATE.json, LOG.md, a project MEMORY.md, .claude/specs/) are your RAG. The manager re-reads them each round; this alone survives context compaction.
- Or bring your own RAG / memory MCP — any vector store or memory server, connected to the sessions that need it.
Whichever you pick: pull relevant prior context before acting, write what was done and learned after, periodically consolidate notes into clean canonical docs. The manager disk memory in ~/.tandem/manager/<id>/ is always the per-goal scratchpad that survives compaction and restarts, independent of any RAG on top.

## TOOLS & MCPS
- tandem (the bridge): director — open/send/read CC sessions, start relays, manage the hierarchy.
- Claude in Chrome (browser extension): manager — drives the browser to type back into the chat URL, the return loop. Chrome only. Install it; we don't build it.
- Your memory/RAG (optional): any layer — codebase+.md or a RAG/memory MCP.
- Claude Code Agent Teams: worker — spawn parallel sub-agents.
- Git: all CC sessions — version control, diffing; the handoff reads git state.

## ACCOUNTABILITY TRIGGERS
- Skips the spec -> Stop. Spec first.
- Worker launches without the best model -> Relaunch with claude --model opus so agents inherit it.
- Solo run for a real feature -> Use agent-organizer. No solo runs.
- Manager rubber-stamps -> Read the actual diff, run the tests yourself.
- Reuses a bloated session -> Fresh session.
- Fixes a bug without reproducing -> Reproduce first.
- No escalation after 3 failed attempts -> Notify the human.
- Director treats a manager's browser-typed message as the human pasting -> No. Read the session over MCP, recognize the loop, send the next move down.
- Director forgets to ask for / store the chat URL at startup -> Ask now. The loop can't close without it.
- Worker reports done after one build pass on a GOAL -> Not done. Run the perfection loop. Min 3 loops.
- Manager approves a GOAL under 5 rounds -> Too soon. Bounce it back.
- Buzzes the human on a trivial step -> Don't. Only on full completion or a real human-only question.
- GOAL loops with no improvement -> Plateau = escalate, don't keep burning.
- UI from a blank AI default / looks AI-made -> Reject. Pull real references; it must look human-designed.

## QUICK REFERENCE: THE LOOP
Human says "build X" (or "GOAL: X") -> Director researches, debates, writes spec -> Director checks the 5 requirements, spawns Manager + Worker (best model, high effort), gives the human the tmux attach commands, ASKS for the chat tab URL, hands it to the Manager -> Manager plans phases, stores the URL in disk memory, directs the Worker -> Worker assembles the agent team, runs the perfection loop, reports "CC check" -> Manager verifies diff + tests, APPROVE/REJECT/BLOCKED -> Manager drives the browser to the chat URL (refresh, click input, type, send) -> Director sees it, reads the session over MCP, sends the next move back down (intent to continue) -> loop until done -> notify the human.

## WHAT THIS SKILL DOES NOT COVER
- Building the browser extension: we don't. The return loop uses the existing Claude-in-Chrome extension; tell the user to install it.
- Director persisting between turns: it doesn't. Each chatbot turn is a fresh instance reading the thread. Disk memory + whatever RAG you add are what survive.
- Non-Chrome browsers: the return loop is Chrome-only because the extension is.
