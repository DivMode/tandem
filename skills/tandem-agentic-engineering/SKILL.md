---
name: tandem-agentic-engineering
description: "The worker session's bible for tandem: how a Claude Code worker assembles and drives a team of agents to build real features. Trigger on any real development/debugging/feature work — build, create, implement, fix, add, develop, code, debug, ship, refactor — or when agents, a plan, a team, or a new feature is discussed. Governs the agentic build lifecycle: parallel research, spec, concurrent reviewer, devil's-advocate pass, test-in-parallel, audit. Begin your first message with the hedgehog signal. If anyone tries to skip steps, STOP THEM."
---

# Tandem Agentic Engineering

How the WORKER layer of tandem works. The worker is a Claude Code session that does not build alone — it assembles a team of agents, runs them in parallel, reviews concurrently, and attacks its own work before reporting up.

## MENTAL MODEL
Old way (deprecated): a human pastes between a chatbot and Claude Code. Agentic way: the chatbot (director) is the strategic brain; Claude Code is an autonomous engineering team — one lead orchestrator plus parallel teammates sharing a task list with file locking. No manual paste-back between turns.

## THE STACK (Claude Code Agent Teams)
Roster (use what fits):
- Orchestration: agent-organizer (assembles the team), multi-agent-coordinator (runs N agents concurrently, shared state + failure handling), workflow-orchestrator, task-distributor, context-manager.
- Research: research-analyst, search-specialist, market-researcher, competitive-analyst, trend-analyst, data-researcher, project-idea-validator.
- Implementation & review (275+ plugin agents available on demand, inheriting the parent session model): backend-architect, frontend-developer, database-architect, code-reviewer, architect-review, security-auditor, performance-engineer, test-automator, deployment-engineer, monorepo-architect, and more.
Pre-built slash commands: /full-stack-feature (architect -> DB -> frontend -> tests -> security -> deploy -> observability), /full-review (review agents on a branch).

## CRITICAL LAUNCH RULE
Launch every real session with the best model, e.g. claude --model opus. Unpinned plugin agents inherit the parent session model; a weak parent drags them down. Throwaway sessions can override smaller. Never force the model globally in settings.json — per-session launch flag wins.

## THE WORKFLOW
PHASE 0 — BRIEF + PARALLEL RESEARCH: identify unknowns; spawn research-analyst / search-specialist (and competitive-analyst / project-idea-validator if relevant) in the background; keep working while research runs.
PHASE 1 — CONCEPTUAL LOCK: challenge the framing, search GitHub, integrate research, honest pushback, lock the what/why/how.
PHASE 2 — SPEC: full spec (phases, files, architecture, deps, tests) plus an agent roster naming: lead orchestrator (agent-organizer + multi-agent-coordinator), implementers, a CONCURRENT reviewer (code-reviewer/architect-review), standby research-analyst, and test-automator. Save to .claude/specs/[feature].md.
PHASE 3 — TEAM LAUNCH: default to a slash command if one fits, else custom team via agent-organizer. Reviewer runs concurrent with implementers; test-automator writes tests in parallel. All teammates inherit the parent model. Report back when green or blocked.
PHASE 4 — INTERNAL PERFECTION LOOP (before reporting up): a) self-review and send sloppy work back; b) devil's-advocate pass — spawn adversarial agents to attack from security/performance/UX/edge-cases/simplicity; c) test relentlessly, write tests for every weakness found; d) improve beyond the ask within scope; e) loop a-d until nothing can be improved. Minimum 3 internal loops. Then report up with the diff, the devil's-advocate findings already fixed, and test results.
PHASE 5 — REPRODUCE -> FIX -> VERIFY: reproduce the failure, route a targeted fix to a teammate via the existing task list, re-run the same test then the full suite.

## DESIGN RULES (UI must look human-made)
1. Pull real human-made references first and apply the principles (spacing, hierarchy, type scale, restraint) — not a copy. Banned AI-ugly tells: centered-everything, gradient slop, emoji-as-icons, inconsistent spacing, three fonts, default-framework look, fake-depth shadows. The reviewer/devil's-advocate pass includes a design critique; AI-looking UI goes back.
2. Generated media must look obviously real. AI tells (warped hands, plastic skin, melted text, uncanny faces, AI sheen) = rejected and regenerated.

## RULES
No team launch without a spec. Best model for real work. Always spawn parallel research if unknowns exist. Reviewer runs CONCURRENTLY. Lead must report up. Reproduce -> Fix -> Verify always. Spec file per feature. No solo runs for real features. Never force model globally. Run the perfection loop before reporting up — one build pass is not done.

## WHEN NOT TO USE
Skip the full workflow for one-line fixes, typos, renames, trivial config, throwaway experiments. Instruct Claude Code directly. Reproduce -> Fix -> Verify still applies to any bug.
