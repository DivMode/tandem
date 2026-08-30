# Security policy

## Trust model

Tandem drives real agent and terminal processes as its OS user. Treat it like remote terminal authority. It is designed for one operator across owner-controlled devices, not for untrusted tenants.

### Public MCP and OAuth

- The public listener binds only to loopback.
- Tailscale Funnel may publish only this listener.
- The canonical resource is one exact HTTPS `/mcp` URL.
- OAuth authorization code flow requires PKCE S256, exact registered redirects, exact resource binding, and the `mcp` scope.
- Owner approval requires a protected password plus a one-time CSRF record and SameSite Strict cookie.
- Authorization codes are short-lived and single use.
- Access tokens are short-lived and audience-bound.
- Refresh tokens rotate. Replay revokes the refresh family and its access tokens.
- Public clients use dynamic registration without client secrets. Redirect URI classes are narrowly validated.
- OAuth bodies, MCP bodies, registration counts, approval attempts, and rates are bounded.
- OAuth state persists only the owner password verifier plus code, access-token, and refresh-token digests. Setup keeps the readable owner password separately in an owner-only file so the operator can complete consent locally.
- OAuth state is written atomically outside the repository with owner-only permissions.

The connector URL is not a credential. Knowing the Funnel hostname does not authorize a client.

An explicit migration mode, `TANDEM_LEGACY_TOKEN_AUTH=1`, accepts a static token only through an Authorization bearer header. Query and path tokens are rejected. New installations should use OAuth.

### Private fleet and enrollment

- The fleet listener is a separate loopback-only server.
- Tailscale Serve publishes it on a distinct tailnet-only HTTPS port.
- Never publish the fleet or enrollment service with Funnel or a public proxy.
- Device WebSockets require the permanent fleet credential in an Authorization header.
- The credential never appears in a WebSocket URL.
- Each new device uses its own random invitation, which expires after 15 minutes if unused. Multiple invitations and enrolled devices are supported.
- The hub's server-side enrollment store keeps only an invitation digest. The owner-only transfer bundle carries the raw invitation long enough to move it to the new device. Atomic claim gives concurrent replays exactly one winner.
- A consumed, expired, revoked, malformed, or unknown invitation cannot be reused.
- The permanent credential is returned only by the private enrollment exchange.
- The 15-minute lifetime applies only to the invitation. An enrolled device retains its protected fleet credential and reconnects until that credential is rotated or removed.
- Device clients connect outbound and open no listener.
- Protocol frames use strict schemas, a 1 MiB maximum, bounded timeouts, bounded backpressure, and at most 32 in-flight requests per device.
- Duplicate device replacement is generation-safe and rejects the older connection's pending requests.

Every fleet machine must be controlled by the same operator and permitted by the tailnet policy. A successfully enrolled device receives the shared fleet credential. Rotate it if a device is lost or compromised.

### Execution authority

- `TANDEM_CWD_ALLOWLIST` is canonicalized and boundary checked before each terminal-backend spawn or owned-session reattachment.
- An empty allowlist denies session creation.
- Setup additionally refuses relative paths, missing directories, and filesystem roots.
- The allowlist is a starting-directory admission gate, not an OS sandbox.
- Only sessions with Tandem's exact engine and installation ownership tags may be driven after restart.
- Arbitrary tmux panes are never adopted.
- With `TANDEM_TERMINAL_BACKEND=herdr`, Tandem uses Herdr's local Unix-socket API directly. It creates no-focus workspaces, starts only Claude or Codex agents, and rediscovers only workspaces carrying this installation's owner/session/engine metadata. Reads, semantic waits, interrupts, native agent-session identity, and persistence remain Herdr-owned. Tandem never focuses or adopts unrelated Herdr workspaces.
- The configured Herdr API path must be an owner-matching Unix socket. Tandem drives its own named Herdr session (`tandem` by default), which it may start headlessly against its own config file under `~/.tandem`. It never starts, stops, or configures the `default` session, a session excluded with `TANDEM_HERDR_MANAGED_SESSION=0`, or any server it did not start, and it never reloads the configuration of a running Herdr server, its own included. It refuses to write a Herdr config file it does not own, including the personal `~/.config/herdr/config.toml`.
- Claude permission bypass is off. Only exact `TANDEM_ALLOW_BYPASS=1` enables it.
- The unattended relay requires that explicit bypass and remains Claude-only.
- Codex, shell, and Hermes are disabled unless explicitly enabled.
- Shell is arbitrary command execution as the OS user.
- Hermes accepts only an exact loopback gateway and explicitly allowlisted writable agent ids. Messaging channels and history discovery are absent.
- Disabled, unknown, and unavailable engines fail before process spawn or gateway contact.

### Privacy

- `list_devices` returns exactly `id`, `name`, `online`, and `engines`.
- Device identity uses configured neutral labels, never hostnames or usernames.
- Default logs exclude prompts, terminal bodies, OAuth artifacts, bearer tokens, nonces, cwd paths, hostnames, usernames, IP addresses, tailnet identity, and histories.
- Audit records retain bounded action metadata and byte counts.
- Startup logs report only safe listener state and the number of configured cwd roots.
- Setup-generated runtime state lives below `~/.tandem` by default, outside the repository, with directories at mode 0700 and files at mode 0600.
- Completion events may contain private summaries by design. Webhook and ntfy delivery are explicit opt-ins.

### Foreman event feed

`get_foreman_events` is the one tool that returns locally recorded activity to the connected MCP client, so its data boundary is stated explicitly.

- **What it exposes.** Bounded structured metadata for each lifecycle transition: a stable event id, an ordinal, a timestamp, the kind (`completed`, `blocked`, `needs_input`, `interrupted`, `closed`, `error`), the device id and the composite `device:localName` session name, the engine, an incarnation epoch and turn number, an optional transcript cursor, a `needs_foreman_review` flag, and at most 200 characters each of `summary` and `reason`.
- **What it never exposes, under any setting.** No `cwd`, `project`, `attachHint`, `handoff`, git facts, environment, tool arguments, prompt, or transcript field.
- **What redaction removes from the two free-text fields.** ANSI and control bytes; credential-shaped runs (API keys, GitHub and Slack tokens, AWS access key ids, JWTs, private-key blocks, `password=`/`token=`/`api_key=` assignments); URLs of any scheme; email addresses; Tailscale MagicDNS hosts (`*.ts.net`) and `100.64.0.0/10` addresses; and absolute filesystem locations — POSIX, home-relative (`~/...`), Windows (`C:\...`) and UNC (`\\host\share`); plus long hex digests and base64 blobs.
- **What it deliberately keeps.** Relative repository paths such as `src/router.ts`, which name a file inside the directory the worker was already admitted to and carry no host or account identity. Redaction is a bounded best effort on free text, not a proof; `TANDEM_FOREMAN_EVENT_SUMMARIES=0` is the setting for hosts where that residual risk is unacceptable.
- **Opting out.** Set `TANDEM_FOREMAN_EVENT_SUMMARIES=0` to omit `summary` and `reason` entirely and keep only the structured transition.
- **Where it lives.** One owner-only file (0600) under the private state directory (0700), replaced atomically, and rejected rather than trusted when its owner, permissions, size, or contents are wrong. Retention is bounded at 400 events and 14 days and enforced on write.
- **What it is not.** It is a per-device record, not a fleet-wide audit trail and not proof of liveness. Events are recorded on the device that produced them, and the tool reads one device per call. A hub rewrites every returned event's `device`/`session` to the id it actually routed to, so a device's self-reported `TANDEM_DEVICE_ID` is never taken on trust.
- **No shared read state.** Reading is strictly read-only and marks nothing. Callers carry their own opaque checkpoint, so one client cannot hide events from another. See [docs/foreman-events.md](docs/foreman-events.md).

## Operator checklist

1. Use narrow project allowlists on every machine.
2. Enable only required engines.
3. Keep permission bypass off unless the unattended Claude relay is required.
4. Keep the private fleet port on Tailscale Serve only.
5. Protect the Tailscale account and tailnet policy with strong authentication.
6. Use a dedicated least-privilege OS account where practical.
7. Move long-running processes under a service manager without putting secrets in command arguments.
8. Rotate the fleet credential and OAuth owner password after a suspected compromise.
9. Patch Tandem, Node.js, Tailscale, tmux, and engine CLIs regularly.
10. Redact private paths, URLs, identities, prompts, and credentials from reports.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use the repository's private GitHub Security Advisory flow or the maintainer contact in the project metadata. Include reproduction steps and the affected revision, but redact credentials, device identity, private URLs, paths, prompts, and personal data.
