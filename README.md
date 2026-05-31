# tandem

An MCP bridge that lets a chat AI (Claude.ai) spawn and drive interactive Claude Code sessions on your own Mac — over your own free Cloudflare quick tunnel.

## What it is

tandem runs a small MCP server on your machine and exposes it through a Cloudflare **quick tunnel** (a free, anonymous `https://<random>.trycloudflare.com` URL — no Cloudflare account, no deploy). A chat AI connects to that URL and can open a real, interactive `claude` session, talk to it, and watch it work, while you sit at the same terminal.

Sessions are real interactive Claude Code TUIs running inside **tmux** (`ccm-<name>`), driven by keystroke injection and screen scraping — *not* `claude -p` / headless — so usage stays on your normal Claude Code subscription. You can `tmux attach -t ccm-<name>` to watch or type alongside the AI. Everything runs locally; the only thing that leaves your machine is the tunnel you started yourself.

## Capabilities

- **Drive a live Claude Code session** — open, send turns to, and read back from an interactive `claude` session running locally in tmux.
- **Shared live session** — you and the chat AI both interact with the same tmux session; `tmux attach` lets you watch or type alongside, and reads are incremental (cursor-based) so neither side blocks the other.
- **Turn-completion detection** — `send_to_session` holds open until the turn finishes (detected via Claude Code's "esc to interrupt" marker plus screen-stability); if a turn runs long it returns `status:"running"` and you poll `read_session` until `idle:true`.
- **Autonomous lead/worker relay** — two interactive sessions message each other with no human in the loop: a lead strategist hands one step at a time to a worker and reviews results, relaying until the lead emits `RELAY_DONE` or a turn cap is hit. Steer it live with `inject_to_relay`.

## Prerequisites

- **Node ≥ 22.6** (the bridge runs TypeScript directly via native type-stripping)
- **tmux** (the session engine)
- **cloudflared** (the free quick tunnel)
- **claude** (Claude Code CLI) on your PATH

## Quick Start

```bash
git clone https://github.com/Maxmedawar/tandem.git
cd tandem
./setup.sh
```

`setup.sh` will:

1. check the prerequisites above (and tell you how to install any that are missing),
2. `npm install`,
3. generate a **fresh random `TANDEM_TOKEN`** into your `.env`,
4. start the bridge and **your own** cloudflared quick tunnel,
5. print your tunnel URL, token, and the exact connector JSON to paste into
   **Claude.ai → Settings → Connectors → Add custom connector**.

It never reuses anyone else's URL or token — the tunnel is yours and disappears when you stop it.

### Configuration

All config lives in `.env` (copied from `.env.example`, git-ignored):

| Variable | Required | Meaning |
|---|---|---|
| `TANDEM_TOKEN` | ✅ | Shared secret; every request must present it. |
| `TANDEM_CWD_ALLOWLIST` | recommended | Colon-separated absolute paths the bridge may operate in. If empty, defaults to `$HOME` and its immediate child dirs — narrow this. |
| `TANDEM_DEFAULT_CWD` | — | Default working dir when a call omits `cwd` (default `$HOME`). |
| `TANDEM_HOST` / `TANDEM_PORT` | — | Local bind address (the tunnel points here). Default `127.0.0.1:8787`. |

Runtime artifacts (session transcripts, audit log) are written to `~/.tandem/`.

## Tools

`open_session`, `list_sessions`, `send_to_session`, `read_session`, `interrupt_session`, `close_session`, `start_relay`, `read_relay`, `inject_to_relay`, `stop_relay`.

## Security

Read this before exposing the bridge.

- **The bridge runs real commands on your machine.** Anyone with your tunnel URL **and** token can drive Claude Code sessions in your allowlisted folders. Treat the token like a password.
- **A token is mandatory.** The server refuses to start without `TANDEM_TOKEN`, and rejects (HTTP 401) every request whose token doesn't match — via `Authorization: Bearer`, `?token=`, or the `/<token>/mcp` path.
- **Directory allowlist.** Sessions and relays can only be opened inside the allowlist. Paths are realpath-canonicalized and boundary-checked, so `../` traversal, symlink escapes, and prefix look-alikes (`/code-evil` vs `/code`) are rejected. Keep the list as narrow as possible.
- **Only `ccm-*` tmux sessions are drivable**, and relay-owned sessions are isolated from the generic session tools. Every spawn/send/interrupt/close/relay action is appended to `~/.tandem/bridge.log`.
- **You run your own tunnel.** The quick tunnel is started locally by you and is anonymous; nothing routes through the author's machine or cloud. Stop the tunnel to take the bridge offline instantly.
- **No secrets in the repo.** Tokens and URLs come only from `.env` / generated runtime files, all git-ignored.

## License

MIT — see [LICENSE](LICENSE).
