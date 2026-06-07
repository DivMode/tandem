# Tandem Skills

Three skills that work together to run the tandem orchestration system:

- **tandem-orchestration** — the master skill. Defines the whole hierarchy (human → director chatbot → manager Claude Code session → worker Claude Code session → sub-agents), the browser return loop, and the GOAL protocol. Every layer reads this.
- **tandem-engineering-workflow** — the standard discipline. The spec → plan mode → review → audit cycle the director and manager hold every build to.
- **tandem-agentic-engineering** — the worker's guide. How a Claude Code worker assembles agent teams, runs concurrent review, and attacks its own work before reporting up.

## Install — on BOTH sides

The skills must be available to both ends of the loop:

1. **The chatbot (Claude.ai or ChatGPT):** load all three as skills so the director follows the protocol.
2. **Claude Code:** make them available to the sessions — drop them into the project (e.g. `.claude/skills/`) or reference them from the project's `CLAUDE.md`.

## Requirements for the autonomous browser loop

The closed loop (no human relaying messages) only works when all of these are true:

- The machine is on and awake (sessions spawn locally in tmux).
- The tandem MCP is connected to the chatbot.
- You're using Chrome.
- The Claude-in-Chrome browser extension is installed and signed in.
- These skills are installed on both sides (chatbot and Claude Code).

If any are missing, everything still works in **manual mode** — you relay between the chat and the sessions yourself.

## Memory — bring your own

Tandem ships no memory system. The codebase plus Markdown files (`MISSION.md`, `STATE.json`, `LOG.md`, `.claude/specs/`) work as RAG out of the box — sessions re-read them each round, which survives context compaction. Or plug in any RAG / memory MCP you prefer.
