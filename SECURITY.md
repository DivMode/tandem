# Security Policy

## Trust model — read this first

tandem **runs real shell commands on the host it runs on.** It spawns and drives
interactive Claude Code sessions (in tmux) inside the directories you allowlist.
Treat it accordingly:

- **Run only your own bridge.** Each user starts their own local bridge and their
  own anonymous Cloudflare quick tunnel. Nothing routes through anyone else's
  machine, and you should never connect to a bridge you don't control.
- **The token is a password.** The bridge refuses to start without `TANDEM_TOKEN`
  (and rejects tokens shorter than 16 chars), and every request must present it
  (`Authorization: Bearer`, `?token=`, or `/<token>/mcp`). Anyone who has your
  tunnel URL **and** token can drive Claude Code in your allowlisted folders.
  Never paste your token into a chat, screenshot, or commit it.
- **Directory allowlist is the blast-radius control.** Sessions/relays can only be
  opened inside `TANDEM_CWD_ALLOWLIST`. Paths are realpath-canonicalized and
  boundary-checked, so `../` traversal, symlink escapes, and prefix look-alikes
  are rejected. Keep the list as narrow as possible. **Skip-permissions does not
  relax this** — the allowlist is enforced before every spawn whether or not
  in-session prompts are skipped, so it can never widen which directories are
  reachable.
- **Stop the tunnel to go offline.** The quick tunnel is yours and disappears when
  you stop it; that instantly takes the bridge off the internet.
- **No secrets in the repo.** Tokens and tunnel URLs come only from your
  git-ignored `.env` / runtime files under `~/.tandem/`.

## Reporting a vulnerability

If you find a security issue, please **do not open a public issue.** Instead,
report it privately:

- Open a [GitHub Security Advisory](https://github.com/Maxmedawar/tandem/security/advisories/new)
  on this repository, **or**
- Email the maintainer (see the `author` field in `package.json`).

Please include reproduction steps and the affected commit. You'll get an
acknowledgement, and a fix or mitigation will be coordinated before any public
disclosure.
