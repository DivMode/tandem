# Let your coding agent install Tandem

Paste this into Claude Code, Codex, or another trusted local coding agent on the computer you want to use as the Tandem hub.

```text
Install Tandem on this computer for me from:
https://github.com/Maxmedawar/tandem

Tandem lets an MCP-capable browser chat or AI client see, start, steer, and stop
my coding agents across all of my enrolled computers.

Do the setup yourself. Keep explanations short. Stop only when you need me to
sign in, approve an account setting, or answer a required question.

Safety rules:
- Read README.md, SETUP.md, SECURITY.md, and .env.example before changing anything.
- Preserve unrelated files and working-tree changes.
- Ask me which exact project folders Tandem may use. Never choose my home folder
  or a filesystem root. Do not continue until I answer.
- Ask which extra engines I want. Claude is the only default. Do not enable
  Codex, Hermes, shell, or Claude permission bypass unless I explicitly request it.
- Never print or paste a consent password, OAuth token, fleet credential,
  invitation token, private Tailscale address, or tailnet identity. You may report
  only the protected local file paths that setup intentionally prints, without
  reading or copying those files' contents.
- Never put a secret in a URL, command argument, issue, screenshot, or log.
- Use Tailscale Funnel only for the public MCP service. Use the separate,
  tailnet-only Tailscale Serve service for device traffic.
- Stop if a verification fails. Do not report partial setup as success.

Steps:
1. Check for Node.js 22.6+, tmux, Tailscale, and at least one supported coding
   agent. Install missing prerequisites with the normal package manager when safe.
   If an install needs administrator approval, ask me first.
2. Check whether Tailscale is running and connected. If I must sign in or enable
   HTTPS or Funnel in my account, give me short numbered instructions and wait.
3. Clone the repository if it is not already present, then enter the repository.
4. After I provide the allowed project folders and optional engines, run:
   TANDEM_CWD_ALLOWLIST=<exact approved folders> ./setup.sh hub
5. Confirm that setup verified public OAuth, rejected an unauthenticated private
   device connection, and detected the hub as a local device.
6. Confirm protected Tandem state is outside the repository and owner-only.
   Check permissions without displaying any secret contents.
7. Run npm run typecheck, npm test, and npm audit.

When everything passes, tell me only:
- that Tandem is ready;
- the stable MCP URL reported by setup;
- where setup stored the consent password, without reading it;
- where setup stored the first device invitation, without reading it;
- that I can run ./setup.sh invite once for each additional computer;
- that an invitation expires after 15 minutes if unused, but an enrolled device
  stays connected and reconnects automatically.
```
