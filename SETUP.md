# Setting up tandem

Get tandem running with a permanent URL you paste into Claude.ai or ChatGPT once and never touch again. About 10 minutes, mostly waiting on installs.

Follow the **Tailscale path** below — it's the recommended setup: free, permanent URL, no domain to buy. (Two other modes are at the bottom if you want them.)

---

## What you need first

- **A computer that stays on.** tandem runs the Claude Code sessions on *your* machine. If it's asleep or off, nothing can run. On a laptop, set it to never sleep while plugged in.
- **Node 22.6+** — https://nodejs.org (or `brew install node`)
- **tmux** — `brew install tmux` (mac) / `apt install tmux` (linux)
- **The Claude Code CLI** (`claude`) — https://claude.com/claude-code
- **Google Chrome + the Claude browser extension** — this is what lets the system report back to your chat on its own. Install "Claude for Chrome" from the Chrome Web Store and sign in.
- **A free Tailscale account** — https://tailscale.com (sign up with Google/GitHub, takes a minute)

> macOS note: install Tailscale with `brew install --cask tailscale-app` (the standalone GUI app — supports Funnel and is the easiest to log into), **not** the Mac App Store version — the sandboxed App Store one can't do the public URL. Then open the app and sign in. (Advanced/headless alternative: `brew install tailscale` + `sudo brew services start tailscale` — CLI only, no GUI.)

---

## Step 1 — Install tandem

```bash
git clone https://github.com/Maxmedawar/tandem.git
cd tandem
./setup.sh
```

When it asks which mode, pick **Tailscale** (it's the default — just press Enter).

---

## Step 2 — Log into Tailscale (one time)

If the script says you're not logged in, run:

```bash
tailscale up
```

A browser window opens — sign in. Done once, forever.

---

## Step 3 — Two one-time toggles (only if the script asks)

The first time, Tailscale may need two switches flipped. The script prints the exact link for whichever it needs:

1. **Enable HTTPS certificates** — in the Tailscale admin console, DNS page.
2. **Allow Funnel** — in the Tailscale admin console, Access Controls.

Flip the one it points to, then re-run `./setup.sh`. You won't need this again.

---

## Step 4 — Copy your URL

When it works, the script prints something like:

```
✓ funnel is live
MCP URL: https://your-machine.your-tailnet.ts.net/<your-token>/mcp
```

That URL is **permanent** — it's the same every time you restart. Copy it.

---

## Step 5 — Connect it to your chat

**Claude.ai:** Settings → Connectors → Add custom connector → paste the MCP URL → save.

**ChatGPT:** Settings → Connectors (Developer Mode, paid plans) → add a custom MCP connector → paste the same URL.

**Claude Code:** add it as an MCP server pointing at the same URL (the script also saves a ready-to-use config to `.tandem/connector.json`).

You should see tandem's tools appear in the connector list.

---

## Step 6 — Install the skills (both sides)

tandem ships with three skills in the `skills/` folder. Install them in **both** places:
- **Your chatbot** (Claude.ai / ChatGPT) — add them as skills.
- **Claude Code** — drop them in your skills folder or reference them from your project's `CLAUDE.md`.

These teach the system how to run the manager/worker loop. See `skills/README.md`.

---

## Step 7 — Run it

In your chat, say:

> start tandem and build [whatever you want]

The system will:
1. Spawn a manager and a worker session on your machine.
2. Give you two `tmux attach` commands so you can watch them live in your terminal.
3. Ask you to paste the URL of the chat tab you're in (so the manager can report back to it).

After that it runs on its own — the manager works, then reports back into your chat through the Chrome extension, and your chatbot keeps the loop going. You can walk away and check in whenever.

---

## Keeping it running

- The machine must stay awake. For long runs, set it to never sleep on power.
- The URL never changes, so you only set up the connector once.
- Restarted your machine? Just run `./setup.sh` again — same URL, back in business.

---

## Troubleshooting

| What you see | What it means / fix |
|---|---|
| "not logged in to Tailscale" | Run `tailscale up` and sign in. |
| "Funnel not permitted" | Flip the Funnel toggle in Tailscale Access Controls (the script prints the link). |
| "HTTPS certs disabled" | Enable HTTPS in the Tailscale admin DNS page (link in the script). |
| URL changed after restart | You're on **quick** mode, not Tailscale. Re-run `./setup.sh` and pick Tailscale for a permanent URL. |
| macOS: funnel won't start | You have the Mac App Store Tailscale. Install the standalone app: `brew install --cask tailscale-app`. |
| Manager can't type back into chat | Chrome + the Claude extension must be installed and signed in, and you must have pasted the chat URL in Step 7. |
| Tools don't appear in the connector | Re-check the URL (including the `/<token>/mcp` part) and that the machine + bridge are running. |

---

## Other modes (optional)

You don't need these if Tailscale is working — they're alternatives.

**Desktop (no tunnel, no account).** If you use the Claude **desktop app** on the same machine, run `./setup.sh` and pick **desktop**. It talks to tandem directly on your computer — no URL, no Tailscale, no token. Only works with the desktop app, not web/mobile chat.

**Quick (instant, no account).** Run `./setup.sh` and pick **quick**. Spins a free temporary URL with no signup. Catch: the URL **changes every restart**, so you'd re-paste it into your connector each time. Good for a quick try, not for permanent use.

---

## A note on what "running" requires

For the hands-off loop (manager reports back to your chat on its own) you need all of: the machine on, the tandem connector added, Chrome with the Claude extension, the skills installed on both sides, and the chat URL handed to the manager in Step 7. Miss one and it still works — you just relay between the chat and the sessions manually instead of it being automatic.
