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

## What this can't do (honest limits)

- **It cannot wake the claude.ai chat tab.** A remote MCP connector is
  request/response; the stateless Streamable-HTTP transport here holds no
  standing server→client channel. tandem can **emit** a completion signal
  (`events.log` + optional webhook) and **ping a device** (your phone, via ntfy),
  but it cannot make the claude.ai chat send an unprompted reply. See
  *Completion events / waking the client* below.
- **The ntfy push reaches a device, not the chat.** It tells *you* the work is
  done so you can return to the chat — it does not resume the conversation.
- **It is not a hosted/multi-tenant service.** Each user runs their own local
  bridge and their own tunnel; there is no shared server.

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
| `TANDEM_SKIP_PERMISSIONS` | — | Spawn `claude` in skip-permissions (autonomous) mode so turns don't stall on allow-prompts. **Default on**; set `0`/`false`/`no`/`off` to require normal prompts. Only suppresses in-session tool prompts — the cwd allowlist is still enforced **before** every spawn, so it never widens reachable dirs. |
| `TANDEM_HOST` / `TANDEM_PORT` | — | Local bind address (the tunnel points here). Default `127.0.0.1:8787`. |

Runtime artifacts (session transcripts, audit log) are written to `~/.tandem/`.

## Tools

Six tools:

- `open_session` — spawn an interactive session in an allowlisted dir. Skip-permissions (autonomous) by default; optional `model` / `effort` set the session model and thinking effort (session-scoped, via `claude --model` / `--effort`).
- `list_sessions` — list live + recent sessions.
- `send_to_session` — send a prompt and wait (bounded by `TANDEM_WAIT_MS`) for the turn; returns the report, or `status:"running"` to call again. **Omit `text` for poll mode** (fetch new output since `cursor` without sending) — this replaces the old `read_session`. Accepts **slash commands** verbatim (see below) and optional per-turn `model` / `effort` overrides.
- `interrupt_session` — Ctrl-C the current turn, keep the session.
- `close_session` — kill the session.
- `relay` — one tool with `action: start | read | inject | stop` for the autonomous lead/worker relay (replaces the old `start_relay` / `read_relay` / `inject_to_relay` / `stop_relay`).

Consolidated from 10 → 6; no capability was removed (the underlying routes are unchanged and still reachable).

## Autonomy & control

**Skip-permissions by default.** Spawned sessions launch with `--dangerously-skip-permissions` so autonomous turns don't stall on allow-prompts. Disable per host with `TANDEM_SKIP_PERMISSIONS=0`. This is contained: it only suppresses Claude Code's in-session tool prompts. The **cwd allowlist is enforced before every spawn** (in `open_session`/`relay` *and* again inside the engine's `spawn`), and the pane is created in the already-validated cwd — so skipping prompts can never widen which directories are reachable. (On a host that has never accepted bypass mode and lacks `skipDangerousModePermissionPrompt`, Claude Code shows a one-time acceptance dialog; the engine auto-accepts it on warmup.)

**Model & effort.** Set them per session at open time, or override per turn on send:

| Param | Accepted values |
|---|---|
| `model` | alias `default` / `opus` / `sonnet` / `haiku`, or a full `claude-*` id (e.g. `claude-opus-4-8`) |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max` |

- **`open_session{ model?, effort? }`** → session-scoped `claude --model` / `--effort` flags (no global side effect).
- **`send_to_session{ model?, effort? }`** → applied to that turn via in-session `/model` / `/effort` controls (these also persist as Claude Code's saved default for new sessions — prefer open-time for strictly session-scoped control).
- Unsupported values are **rejected with a clear 400**, never silently ignored.

**Slash-command passthrough.** Any slash command sent as `send_to_session`'s `text` reaches the TUI verbatim and executes — the autocomplete's exact match resolves on the submit. Examples:

```jsonc
send_to_session { "name": "s1", "text": "/status" }     // session/model/account status
send_to_session { "name": "s1", "text": "/mcp" }        // MCP server status
send_to_session { "name": "s1", "text": "/model opus" } // switch model
send_to_session { "name": "s1", "text": "/goal ship the parser" } // custom command
```

## Completion events / waking the client

tandem **emits** a completion event the moment a turn or relay finishes — you don't have to keep polling to learn that work is done. Detection reuses the engine's proven idle/done logic (the "esc to interrupt" marker + screen-stability for turns; `RELAY_DONE` / cap for relays).

**What is emitted** — a JSON object:

```json
{ "ts": "…", "type": "session", "status": "done", "id": "<session|loopId>", "cursor": 12345, "summary": "…", "reason": "…" }
```

**Where it goes (the EMIT side, which this repo implements):**

1. **`~/.tandem/events.log`** — one JSON line is appended per completion. Durable; `tail -f` it or have any local process watch it.
2. **`TANDEM_DONE_WEBHOOK`** — if set, the same JSON is `POST`ed to that URL (fire-and-forget, no deps). Point it at any local listener, notifier, or automation.

### Phone notifications (ntfy)

For a real buzz on your phone when a session finishes, tandem can push to
[ntfy](https://ntfy.sh) (free, no account) on top of the event emit above. It's
off until you set a topic. Three steps:

1. **Install the ntfy app** (iOS App Store / Google Play), or use the web app.
2. **Subscribe to a topic** in the app — pick a long, hard-to-guess name (anyone
   who knows the topic can read it), e.g. `tandem-9f3a2c-done`.
3. **Set `TANDEM_NTFY_TOPIC`** in your `.env` to that exact topic (and optionally
   `TANDEM_NTFY_SERVER` if you self-host ntfy; default `https://ntfy.sh`).

Now each completion sends a notification titled `tandem: <session id> done` with a
one-line summary (id, status, cursor, summary text). The POST is fire-and-forget;
if ntfy is unreachable the failure is logged to `~/.tandem/bridge.log` and the
bridge keeps running.

**Honest note:** this pings a **device** (your phone / the ntfy app) — it does
**not** and **cannot** wake the claude.ai chat or post a reply there. It tells
*you* the work is done so you can go back to the chat; the chat client still
can't be woken by a server-initiated signal (see below).

### Persistent manager: disk-backed memory + escalation

The autonomous `relay` runs a lead ("manager") session that drives a worker. To
make that manager **resumable** — surviving context compaction and bridge
restarts — its working state lives on disk, not just in a context window, under
`~/.tandem/manager/<loopId>/`:

- `MISSION.md` — the standing definition of "done" (written once, re-read each turn).
- `STATE.json` — the working set: `status` (`running` / `blocked` / `done`), `turn`, current `task`, and `blockedReason`.
- `LOG.md` — an append-only decision log, one line per turn.

Each turn the manager is **re-grounded** from these files (mission + recent
decisions are re-fed into the lead), so continuity comes from re-reading disk
rather than from a process "staying alive."

**Escalation.** When the manager genuinely can't proceed without you — repeated
worker failure, a call that needs your authority, or an irreversible action — it
emits `BLOCKED: <reason>` on its own line. tandem then fires an **urgent** ntfy
push titled `tandem: <id> NEEDS YOU` (priority `urgent`, the blocking reason in
the body) and writes an `event:"escalation"` line to `events.log` — instead of
silently burning turns until a cap. This is the one place a device-push is the
right primitive: **you** are the only node at the top that can actually be woken.
Normal completions are unchanged (quiet `done` push); escalation is the loud one.

**The missing piece (client side, out of scope / not under our control):** turning a completion event into an *unprompted* chat reply requires the chat client to be woken by it. Today **claude.ai chat cannot be woken this way** — a remote MCP connector is request/response, and the stateless Streamable-HTTP transport here holds no standing server→client channel to deliver a server-initiated notification to the chat UI. So tandem gives you the reliable signal (`events.log` + webhook); bridging that into an automatic message would need a client that polls `events.log`/the webhook and re-prompts the model — which only works in a harness you control, not in claude.ai chat as it exists now.

## Security

Read this before exposing the bridge. For the full trust model and how to report
a vulnerability, see [SECURITY.md](SECURITY.md).

- **The bridge runs real commands on your machine.** Anyone with your tunnel URL **and** token can drive Claude Code sessions in your allowlisted folders. Treat the token like a password.
- **A token is mandatory.** The server refuses to start without `TANDEM_TOKEN`, and rejects (HTTP 401) every request whose token doesn't match — via `Authorization: Bearer`, `?token=`, or the `/<token>/mcp` path.
- **Directory allowlist.** Sessions and relays can only be opened inside the allowlist. Paths are realpath-canonicalized and boundary-checked, so `../` traversal, symlink escapes, and prefix look-alikes (`/code-evil` vs `/code`) are rejected. Keep the list as narrow as possible. **Skip-permissions does not relax this** — the allowlist check runs before spawn whether or not prompts are skipped, and a cwd outside it still returns `403`.
- **Only `ccm-*` tmux sessions are drivable**, and relay-owned sessions are isolated from the generic session tools. Every spawn/send/interrupt/close/relay action is appended to `~/.tandem/bridge.log`.
- **You run your own tunnel.** The quick tunnel is started locally by you and is anonymous; nothing routes through the author's machine or cloud. Stop the tunnel to take the bridge offline instantly.
- **No secrets in the repo.** Tokens and URLs come only from `.env` / generated runtime files, all git-ignored.

## License

MIT — see [LICENSE](LICENSE).
