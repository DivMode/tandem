# tandem

An MCP server that lets a chat AI (Claude.ai) spawn and drive interactive Claude Code sessions on your local Mac.

## What it is

tandem bridges a chat AI and your local machine. Through the Model Context Protocol, a chat-side assistant can open a real Claude Code session on your Mac, talk to it, and watch it work — while you stay in the loop at the same terminal. It turns a single chat thread into a controller for live, hands-on coding sessions.

## Capabilities

- **Drive a live Claude Code session** — open, send turns to, and read back from an interactive Claude Code session running locally.
- **Shared live session** — you and the chat AI both interact with the same session at once, neither blocking the other.
- **Push ping-back on completion** — when a session's turn finishes, tandem pushes a notification back instead of making you poll for it.
- **Autonomous lead/worker relay** — run two agents that message each other: a lead strategist session and a worker session, relaying back and forth until the task is done.

## License

MIT — see [LICENSE](LICENSE).
