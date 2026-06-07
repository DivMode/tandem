# tandem - one-paste setup

Paste the prompt below into a new Claude Code session. It does the whole install for you and pauses with simple instructions whenever you need to click something in your own account.

(You need Claude Code installed first: `npm i -g @anthropic-ai/claude-code`, which needs Node 22.6+. Then run `claude`.)

---

```
You are setting up "tandem" on this machine for me. tandem is an MCP bridge (public repo: https://github.com/Maxmedawar/tandem) that lets my chat AI drive Claude Code sessions here over a persistent Tailscale Funnel URL. Do the whole setup yourself and only stop when you genuinely need me to click something in my own account.

<rules>
- Run network and tailscale commands plainly (macOS has no `timeout` command, so do NOT prefix anything with `timeout 40` or `gtimeout 40`). Where a command supports its own time limit, use it — e.g. the /health check uses `curl --max-time 40 ...`. If a command hangs or errors, treat it as a failure, tell me plainly, and move to the matching STOP block below.
- Do the install steps silently. Do not explain what you are about to do or narrate progress. Only talk to me when you hit a STOP block or when you are finished.
- You CANNOT click inside my browser or my Tailscale account. When a step needs that, use a STOP block: print the exact simple instructions, then wait for me before doing anything else. Never guess past a STOP. When I reply: if I say "continue" or "done", re-check the step worked and move on; if I describe a problem or say I am stuck, help me fix it in plain language, then continue once it is sorted.
- Keep STOP instructions plain and non-technical: numbered, short, no jargon. Give me the exact link to click when there is one.
- Never print my token anywhere except the single final MCP URL at the very end.
</rules>

<steps>
1. PREREQS. Check for: Node 22.6+, tmux, the `claude` CLI, and `tailscale`. Install missing Node / tmux / `claude` using the system package manager (on macOS use Homebrew). For Tailscale on macOS, DO NOT use brew or sudo — installing the standalone app by hand is far more reliable. If `tailscale` is missing on macOS, do this STOP block:
   PAUSE. Install Tailscale by hand (takes a minute):
   1. Open this link: https://tailscale.com/download/mac
   2. Download the standalone Tailscale app (not the Mac App Store version).
   3. Drag Tailscale into your Applications folder.
   4. Open it and sign in (any account, it is free).
   Then come back here and type: continue
   (On Linux, install with: `curl -fsSL https://tailscale.com/install.sh | sh`.) If any other tool cannot be auto-installed, use a STOP block telling me how to install it.

2. TAILSCALE LOGIN. Run `tailscale status`. If it says logged out / needs login / not running, do this STOP block:
   PAUSE. One quick thing:
   1. Open the Tailscale app on this computer.
   2. Click "Log in" and sign in (any account, it is free).
   3. Wait until it says Connected.
   Then come back here and type: continue

3. GET THE CODE. If a `tandem` folder is not already here, run `git clone https://github.com/Maxmedawar/tandem.git`. cd into it.

4. FREE THE PORT. Run `lsof -ti:8787 | xargs kill -9 2>/dev/null` to clear any old bridge, ignore errors.

5. TURN ON THE FUNNEL (this is where the two one-time account switches live). Run `tailscale funnel --bg 8787` and read the result:
   - If it succeeds, continue to step 6.
   - If the output mentions Funnel is not enabled / not permitted / a node attribute, it will include a link. Do this STOP block, pasting the real link it gave:
     PAUSE. One quick switch to flip (takes 30 seconds):
     1. Open this link: <paste the exact link from the output>
     2. Click the button to turn Funnel on.
     3. Come back here and type: continue
   - If the output mentions HTTPS is not enabled / certificates, do this STOP block:
     PAUSE. One quick switch to flip (takes 30 seconds):
     1. Open this link: https://login.tailscale.com/admin/dns
     2. Find "HTTPS Certificates" and click Enable.
     3. Come back here and type: continue
   After I type continue, run the same funnel command again. Repeat until it succeeds (I may need to flip both switches, one at a time).

6. START THE BRIDGE + PRINT THE URL. Run `TANDEM_SETUP_MODE=tailscale ./setup.sh`. It installs deps, reuses or makes the token, starts the bridge, and prints the MCP URL. If it asks anything interactively, pick tailscale.

7. VERIFY. Get my funnel hostname from `tailscale status --json` (the DNSName), then run `curl --max-time 40 -s -o /dev/null -w "%{http_code}" https://<that-host>/health`. It must print 200. If it does not, tell me plainly what failed and stop.
</steps>

<finish>
When /health returns 200, print exactly this and nothing else after it:

tandem is live. Here is your connector:

   URL:  <the full MCP URL ending in /<token>/mcp>

To connect it in Claude.ai:
   1. In the left sidebar, click your name / "Customize", then click "Connectors".
   2. At the top of the Connectors panel, click the three dots (...) and choose "Add custom connector".
   3. Give it a name: Tandem
   4. Paste the URL above into the URL field (the second box). Click enter.
   5. That is it - you are set.

Then install the "Claude for Chrome" extension and sign in, and in any chat say: start tandem

Your Claude Code already has the tandem skills. To give your chat AI the director skill: in Claude.ai open Settings > Customize > Skills, click + / Create skill, upload the file tandem-orchestration.zip from your tandem folder, and toggle it on.

(If Claude.ai ever asks you to "sign in" to the connector instead of just adding it, the URL is wrong - re-paste the full one above, including the part after the last slash.)
```
