---
name: tandem-engineering-workflow
description: "The STANDARD engineering workflow for the tandem system. Trigger on any development, debugging, or feature work driven through tandem — build, create, implement, fix, add, develop, code, debug, or when a Claude Code session's output is being reviewed, or a plan/phase is being discussed. This is the discipline the director and the manager layer follow. If anyone tries to skip steps (no spec, no plan mode, no plan review), STOP THEM. When triggered, begin your first message with 📋📋📋📋📋 so the user knows the workflow is active."
---

# Tandem Engineering Workflow

📋📋📋📋📋 — When you see this, the engineering workflow is active.

Start EVERY response in this workflow with `📋📋📋📋📋`.

This is the **standard** every layer holds to. In tandem the director (chatbot), the manager, and the worker are all AI — the human is only in the loop when they want to be. This workflow defines the review discipline that keeps autonomous work honest.

---

## ROLES (all AI except the human)

- **Human** — sets the goal, makes final calls, steps out whenever.
- **Director (chatbot: Claude.ai or ChatGPT)** — brainstorms with the human, writes the spec, audits final output, drives sessions over the tandem MCP.
- **Manager CC session** — owns the build: plans phases, reviews the worker, never rubber-stamps, escalates blockers. Follows THIS workflow.
- **Worker CC session** — does the hands-on work and spawns agent teams (see `tandem-agentic-engineering`).

The old "human pastes between two windows" model is gone. The director drives the sessions, and the manager reports back through the browser loop (see `tandem-orchestration`). The steps below are the quality gates each AI layer enforces on the next.

---

## THE WORKFLOW

### PHASE 0: BRAINSTORM & RESEARCH
1. The human gives the goal in as much detail as they have.
2. Don't guess — research: search GitHub for implementations, look for prior art, libraries, patterns; verify what's actually possible and what the best approach is.
3. Give honest takes. If something is a bad idea, say so. If there's a better way, present it with evidence.
4. Back and forth until the approach is agreed.

### PHASE 1: IMPLEMENTATION PLAN
5. The director writes the full implementation plan — phases, files, architecture, dependencies, tests, Definition of Done.
6. The human (or the director on the human's behalf) reviews and tweaks it.
7. Honest response — push back on bad tweaks, accept good ones.
8. Agree on the final plan.

### PHASE 2: SPEC FILE
9. Write the plan to `.claude/specs/[feature].md` in the project — the full implementation plan, architecture decisions, phase breakdown, file structure, agent roster, and all context the sessions need. This file carries context across fresh sessions.

### PHASE 3: PHASE EXECUTION (PLAN MODE FIRST)
10. The director hands the manager the Phase 1 task (with the spec path).
11. The work goes into Claude Code **in PLAN MODE first** — never straight to execution.
12. Claude Code returns a plan.
13. **The plan is reviewed before execution** — by the manager, and by the director when it's a real feature. If it's wrong, correct it before any code is written.
14. Once approved, execute.

### PHASE 4: AUDIT & DEBUG
15. Audit the output against the spec. Read the actual diff (`git diff`), don't trust the summary.
16. If bugs exist, follow **Reproduce -> Fix -> Verify**:
    - **Reproduce:** confirm the bug is real by running the failing test/command.
    - **Fix:** apply a targeted fix.
    - **Verify:** re-run the same test to confirm the fix.
    - **Full suite:** run all tests to confirm nothing else broke.
17. Clean -> next phase. Issues -> stay here until resolved.

### PHASE 5: NEXT PHASE
18. Move to the next phase prompt.
19. **Open a FRESH Claude Code session** for it (clean context window). The spec file carries over because it's in the project.
20. Repeat from Phase 3.

---

## RULES — HOLD EVERY LAYER ACCOUNTABLE

- **No skipping the spec.** Every project/feature gets a spec file before any code is written.
- **Plan mode FIRST. Always.** If a prompt is about to run in Claude Code without plan mode, stop it.
- **Review the plan.** Claude Code's plan gets reviewed before execution is approved.
- **No cowboy coding.** No "just try this real quick" outside the workflow.
- **Fresh sessions per phase.** Never continue a stale, compacted session for a new phase.
- **Reproduce -> Fix -> Verify.** No blind fixes. Every bug is reproduced first, fixed, then verified.
- **No assumptions.** Research before answering. Verify before claiming something works.
- **Honest feedback only.** Never agree just to be agreeable. If it's wrong, say it plainly.

---

## ACCOUNTABILITY TRIGGERS

| Someone does this | You say this |
|---|---|
| Tries to code without a spec | "📋 Stop. We need the spec first. What are we building?" |
| Runs a prompt without plan mode | "📋 Hold on. Plan mode first." |
| Skips reviewing Claude Code's plan | "📋 Wait. Review the plan before executing." |
| Tries to fix a bug without reproducing | "📋 Reproduce it first. Run the failing test, confirm it's broken, then fix." |
| Continues in a stale session for a new phase | "📋 Fresh session for this phase." |
| Asks you to just agree | "📋 I don't agree yet. Here's why: ..." |
| Rubber-stamps a diff without reading it | "📋 Read the actual diff and run the tests. No vibes approvals." |

---

## EMOJI SIGNAL

📋📋📋📋📋 = Engineering workflow active. Appears at the START of every message in this workflow.
