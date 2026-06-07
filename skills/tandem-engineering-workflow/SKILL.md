---
name: tandem-engineering-workflow
description: "The STANDARD engineering workflow for the tandem system. Trigger on any development, debugging, or feature work driven through tandem — build, create, implement, fix, add, develop, code, debug, or when a Claude Code session's output is being reviewed, or a plan/phase is being discussed. This is the discipline the director and the manager layer follow. If anyone tries to skip steps (no spec, no plan mode, no plan review), STOP THEM. When triggered, begin your first message with the clipboard signal so the user knows the workflow is active."
---

# Tandem Engineering Workflow

This is the standard every layer holds to. In tandem the director (chatbot: Claude.ai or ChatGPT), the manager, and the worker are all AI — the human is only in the loop when they want to be. This workflow defines the review discipline that keeps autonomous work honest.

## ROLES (all AI except the human)
- Human — sets the goal, makes final calls, steps out whenever.
- Director (chatbot) — brainstorms with the human, writes the spec, audits final output, drives sessions over the tandem MCP.
- Manager CC session — owns the build: plans phases, reviews the worker, never rubber-stamps, escalates blockers. Follows THIS workflow.
- Worker CC session — does the hands-on work and spawns agent teams (see tandem-agentic-engineering).

The old "human pastes between two windows" model is gone. The director drives the sessions; the manager reports back through the browser loop (see tandem-orchestration).

## THE WORKFLOW
PHASE 0 — BRAINSTORM & RESEARCH: human gives the goal; don't guess, research (GitHub, prior art, libraries, patterns); give honest takes; agree on the approach.
PHASE 1 — IMPLEMENTATION PLAN: director writes the full plan (phases, files, architecture, dependencies, tests, Definition of Done); review and tweak; agree on the final plan.
PHASE 2 — SPEC FILE: write the plan to .claude/specs/[feature].md so it carries context across fresh sessions.
PHASE 3 — PHASE EXECUTION (PLAN MODE FIRST): hand the manager one phase; run it in Claude Code in PLAN MODE first; review the returned plan before execution; only then execute.
PHASE 4 — AUDIT & DEBUG: read the actual diff (git diff), not the summary; bugs follow Reproduce -> Fix -> Verify, then run the full suite; clean -> next phase.
PHASE 5 — NEXT PHASE: open a FRESH Claude Code session (clean context); the spec file carries over; repeat from Phase 3.

## RULES — HOLD EVERY LAYER ACCOUNTABLE
- No skipping the spec. - Plan mode FIRST, always. - Review the plan before approving execution. - No cowboy coding. - Fresh sessions per phase. - Reproduce -> Fix -> Verify, no blind fixes. - No assumptions; research and verify. - Honest feedback only.
