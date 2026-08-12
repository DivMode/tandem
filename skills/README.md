# Tandem skills

These optional skills teach compatible agents how to use Tandem well. The MCP bridge works without them.

- `tandem-orchestration`: engine-neutral multi-agent and multi-device routing, session control, delegation, and verification. It also explains the separate Claude-only relay.
- `tandem-engineering-workflow`: engine-neutral planning, implementation, testing, review, and reporting discipline.
- `tandem-agentic-engineering`: a specialized guide for Claude Code workers that can spawn their own internal agent teams.

Install only the skills that the chosen MCP client or worker runtime understands. Do not assume every chat or coding agent has the same skill format.

The release includes `tandem-orchestration.zip` for clients that accept a skill archive. Setup does not modify Claude, Codex, or other agent configuration. Install a skill only when the chosen runtime supports it and the operator requests it.

The general path is:

1. Give the director the orchestration and engineering workflow skills.
2. Give a worker only the engine-specific guidance it can actually follow.
3. Call `list_devices`, select an advertised engine, and preserve returned global session names.
4. Verify worker output independently before declaring the task complete.

Tandem ships no external memory service. Projects can keep durable state in ordinary repository files or use a separate memory/RAG system chosen by the operator.
