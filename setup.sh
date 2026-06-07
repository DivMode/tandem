#!/usr/bin/env bash
#
# tandem one-command setup.
#
# Three modes, picked once at the top:
#   tailscale (default) — your own bridge behind Tailscale Funnel: a PERSISTENT
#                         public URL (https://<machine>.<tailnet>.ts.net) that
#                         never changes across restarts, gated by a fresh
#                         random token. Recommended for web chat (claude.ai).
#                         Needs the tailscale CLI + a one-time login.
#   quick               — your own bridge behind your own free Cloudflare quick
#                         tunnel + the same token gate, for web chat with zero
#                         accounts. Instant, but the URL changes every run.
#                         ('web' is accepted as a legacy alias.)
#   desktop             — a local stdio connector for desktop chat apps
#                         (Claude Desktop, ChatGPT desktop). No HTTP server,
#                         no tunnel, no token.
#
#   ./setup.sh                            # asks (defaults to tailscale)
#   TANDEM_SETUP_MODE=quick ./setup.sh    # non-interactive override
#
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
# Remember an explicit TANDEM_PORT from the caller's env — it must survive
# sourcing .env below (final precedence: env > .env > 8787).
PORT_OVERRIDE="${TANDEM_PORT:-}"
HOST="127.0.0.1"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

say "tandem setup"
echo

# ── 0. Pick the mode: tailscale (persistent) / quick (instant) / desktop ────
MODE="${TANDEM_SETUP_MODE:-}"
if [ -z "$MODE" ]; then
  if [ -t 0 ]; then
    read -r -p "Connect how? [t]ailscale funnel (persistent URL, recommended) / [q]uick tunnel (instant, no account) / [d]esktop app (local stdio)? [t] " MODE
  fi
  MODE="${MODE:-t}"
fi
case "$MODE" in
  t|T|tailscale) MODE="tailscale" ;;
  q|Q|quick)     MODE="quick" ;;
  w|W|web)       warn "mode 'web' is now called 'quick' (Cloudflare quick tunnel) — using that. For a persistent URL use 'tailscale'."
                 MODE="quick" ;;
  d|D|desktop)   MODE="desktop" ;;
  *) die "unknown mode '$MODE' (use t/tailscale, q/quick, or d/desktop)" ;;
esac
say "✓ mode: ${MODE}"

# ── 1. Prerequisites ────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die \
  "node is not installed. Install Node 22.6+ from https://nodejs.org (or: brew install node)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".").map(Number)[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".").map(Number)[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  die "Node $(node -v) is too old. tandem needs >= 22.6 (it runs TypeScript via native type-stripping)."
fi

# cloudflared is only needed for the quick (Cloudflare tunnel) path.
if [ "$MODE" = "quick" ] && ! command -v cloudflared >/dev/null 2>&1; then
  die "cloudflared is not installed. Install it, then re-run ./setup.sh
       macOS:  brew install cloudflared
       other:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
fi

# The tailscale CLI is only needed for the tailscale (Funnel) path.
# TANDEM_TS_APP_BIN exists so tests can point the macOS app fallback elsewhere.
TS_BIN=""
TS_APP_BIN="${TANDEM_TS_APP_BIN:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
if [ "$MODE" = "tailscale" ]; then
  if command -v tailscale >/dev/null 2>&1; then
    TS_BIN="tailscale"
  elif [ -x "$TS_APP_BIN" ]; then
    # macOS standalone app: ships the CLI inside the bundle, not on PATH.
    TS_BIN="$TS_APP_BIN"
  else
    die "tailscale is not installed (or not on PATH). Install it, then re-run ./setup.sh
       macOS:  brew install --cask tailscale-app   (the STANDALONE app)
               NOTE: the sandboxed Mac App Store version of Tailscale cannot run
               Funnel — if you installed from the App Store, replace it with the
               standalone app (or the open-source CLI: brew install tailscale).
       linux:  curl -fsSL https://tailscale.com/install.sh | sh"
  fi

  # Logged in + daemon up? Funnel needs both. Login is a ONE-TIME browser step
  # we never automate — detect, instruct, exit.
  TS_STATUS_OUT="$("$TS_BIN" status 2>&1)" && TS_STATUS_RC=0 || TS_STATUS_RC=$?
  if [ "$TS_STATUS_RC" -ne 0 ]; then
    case "$TS_STATUS_OUT" in
      *"Logged out"*|*NeedsLogin*|*"not logged in"*)
        die "Tailscale is installed but not logged in.
       Run:  tailscale up        (macOS standalone app: open Tailscale.app → Log in)
       Finish the one-time browser login, then re-run ./setup.sh." ;;
      *"Tailscale is stopped"*|*stopped*)
        die "Tailscale is stopped. Run:  tailscale up   — then re-run ./setup.sh." ;;
      *"failed to connect"*|*"is Tailscale running"*|*"no running tailscaled"*)
        die "The Tailscale daemon isn't running.
       macOS standalone app:        open Tailscale.app
       macOS (brew open-source):    sudo brew services start tailscale
       linux:                       sudo systemctl start tailscaled
       Then re-run ./setup.sh." ;;
      *)
        printf '%s\n' "$TS_STATUS_OUT" >&2
        die "tailscale status failed (output above). Fix it, then re-run ./setup.sh." ;;
    esac
  fi
fi

if ! command -v tmux >/dev/null 2>&1; then
  die "tmux is not installed. The bridge drives Claude Code inside tmux.
       macOS:  brew install tmux
       linux:  apt install tmux  (or your package manager)"
fi

if ! command -v claude >/dev/null 2>&1; then
  warn "the 'claude' CLI (Claude Code) was not found on PATH."
  warn "Install it from https://claude.com/claude-code — the bridge spawns 'claude' sessions."
fi

case "$MODE" in
  tailscale) say "✓ node $(node -v), tailscale, tmux present" ;;
  quick)     say "✓ node $(node -v), cloudflared, tmux present" ;;
  *)         say "✓ node $(node -v), tmux present" ;;
esac

# ── 2. Dependencies ─────────────────────────────────────────────────────────
say "Installing dependencies (npm install)…"
npm install --silent

# ── 3. .env (token is TUNNEL-ONLY: the stdio path is local and needs none) ──
[ -f .env ] || cp .env.example .env

if [ "$MODE" != "desktop" ]; then
  gen_token() {
    if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
    else node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
    fi
  }

  # Read current value (if any) from .env. Reusing an existing token is what
  # keeps the tailscale MCP URL identical across re-runs of this script.
  CUR_TOKEN="$(grep -E '^TANDEM_TOKEN=' .env | head -1 | cut -d= -f2- || true)"
  if [ -z "$CUR_TOKEN" ]; then
    TOKEN="$(gen_token)"
    # portable in-place edit (macOS + GNU sed)
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^TANDEM_TOKEN=.*|TANDEM_TOKEN=${TOKEN}|" .env
    else
      sed -i '' "s|^TANDEM_TOKEN=.*|TANDEM_TOKEN=${TOKEN}|" .env
    fi
    say "✓ generated a fresh TANDEM_TOKEN into .env"
  else
    TOKEN="$CUR_TOKEN"
    say "✓ using existing TANDEM_TOKEN from .env"
  fi
fi

# Ensure an allowlist exists; default to ~/code so first run is usable.
CUR_ALLOW="$(grep -E '^TANDEM_CWD_ALLOWLIST=' .env | head -1 | cut -d= -f2- || true)"
if [ -z "$CUR_ALLOW" ]; then
  DEFAULT_ALLOW="${HOME}/code"
  mkdir -p "$DEFAULT_ALLOW"
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^TANDEM_CWD_ALLOWLIST=.*|TANDEM_CWD_ALLOWLIST=${DEFAULT_ALLOW}|" .env
  else
    sed -i '' "s|^TANDEM_CWD_ALLOWLIST=.*|TANDEM_CWD_ALLOWLIST=${DEFAULT_ALLOW}|" .env
  fi
  warn "TANDEM_CWD_ALLOWLIST was empty — defaulted to ${DEFAULT_ALLOW}."
  warn "Edit .env to add/restrict the folders the bridge may operate in."
fi

# Load .env into this shell for launching the processes.
set -a; . ./.env; set +a

# Resolve the port AFTER .env so the precedence is: explicit env > .env > 8787.
# Export the winner so the bridge binds exactly the port we report and check.
PORT="${PORT_OVERRIDE:-${TANDEM_PORT:-8787}}"
export TANDEM_PORT="${PORT}"

# ── DESKTOP MODE: print the local stdio connector and stop ──────────────────
# No bridge process, no tunnel, no token: the desktop app spawns the server
# itself over stdio (same trust as your own terminal; the cwd allowlist still
# applies — the server reads .env on its own via process.loadEnvFile).
if [ "$MODE" = "desktop" ]; then
  mkdir -p .tandem
  cat > .tandem/desktop-connector.json <<JSON
{
  "mcpServers": {
    "tandem": {
      "command": "node",
      "args": ["--experimental-strip-types", "${ROOT}/src/stdio-server.ts"]
    }
  }
}
JSON

  say "Smoke-testing the stdio server (initialize + tools/list)…"
  SMOKE_OUT="$(printf '%s\n%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"setup-smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    | node --experimental-strip-types src/stdio-server.ts 2>/dev/null || true)"
  for TOOL in open_session list_sessions send_to_session interrupt_session close_session relay; do
    printf '%s' "$SMOKE_OUT" | grep -q "\"name\":\"${TOOL}\"" || \
      die "stdio smoke test failed: tool '${TOOL}' missing from tools/list. Run 'npm run start:stdio' to debug."
  done
  say "✓ stdio server answers with all 6 tools"

  echo
  say "──────────────────────────────────────────────────────────────"
  say " tandem is ready (desktop / local stdio — no tunnel, no token)"
  say "──────────────────────────────────────────────────────────────"
  echo
  echo " Add this to your desktop app's MCP config (also saved to"
  echo " .tandem/desktop-connector.json):"
  echo
  cat .tandem/desktop-connector.json
  echo
  echo " Claude Desktop:  merge the \"tandem\" entry under \"mcpServers\" in"
  echo "   ~/Library/Application Support/Claude/claude_desktop_config.json"
  echo "   then restart the app."
  echo " ChatGPT desktop: add a local MCP server with the same command + args."
  echo
  echo " Nothing keeps running — the app spawns the server on demand."
  echo " For web chat (claude.ai in a browser) re-run with:"
  echo "   TANDEM_SETUP_MODE=tailscale ./setup.sh   (persistent URL, recommended)"
  echo "   TANDEM_SETUP_MODE=quick ./setup.sh       (instant, URL changes per run)"
  say "──────────────────────────────────────────────────────────────"
  exit 0
fi

# ── 4. Start the bridge (shared by both tunnel modes) ───────────────────────
mkdir -p .tandem
BRIDGE_PID=""
if command -v curl >/dev/null 2>&1 \
   && curl -fsS --max-time 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
  # A bridge already answers on this port — reuse it instead of double-binding.
  BRIDGE_PID="$(cat .tandem/bridge.pid 2>/dev/null || echo '?')"
  say "✓ bridge already running on http://${HOST}:${PORT} (PID ${BRIDGE_PID}) — reusing it"
  warn "  changed .env since it started? kill it (kill \$(cat .tandem/bridge.pid)) and re-run."
else
  say "Starting the bridge on http://${HOST}:${PORT}…"
  node --experimental-strip-types src/server.ts >.tandem/bridge.log 2>&1 &
  BRIDGE_PID=$!
  echo "$BRIDGE_PID" > .tandem/bridge.pid
  sleep 2
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    cat .tandem/bridge.log >&2
    die "bridge failed to start (see output above)."
  fi
fi

# ── 5a. QUICK MODE: your own Cloudflare quick tunnel ────────────────────────
if [ "$MODE" = "quick" ]; then
  say "Opening your own free Cloudflare quick tunnel…"
  : > .tandem/tunnel.log
  cloudflared tunnel --url "http://${HOST}:${PORT}" >.tandem/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > .tandem/tunnel.pid

  # Wait (up to ~30s) for the trycloudflare URL to appear.
  TUNNEL_URL=""
  for _ in $(seq 1 30); do
    TUNNEL_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' .tandem/tunnel.log | head -1 || true)"
    [ -n "$TUNNEL_URL" ] && break
    sleep 1
  done
  [ -n "$TUNNEL_URL" ] || { cat .tandem/tunnel.log >&2; die "could not obtain a quick tunnel URL."; }
  echo "$TUNNEL_URL" > .tandem/tunnel.url

  MCP_URL="${TUNNEL_URL}/${TOKEN}/mcp"
  cat > .tandem/connector.json <<JSON
{
  "name": "tandem",
  "url": "${MCP_URL}"
}
JSON

  echo
  say "──────────────────────────────────────────────────────────────"
  say " tandem is live (quick tunnel)"
  say "──────────────────────────────────────────────────────────────"
  echo " Tunnel URL : ${TUNNEL_URL}"
  echo " Token      : ${TOKEN}"
  echo " MCP URL    : ${MCP_URL}"
  echo
  echo " Paste this into Claude.ai → Settings → Connectors → Add custom connector:"
  echo
  cat .tandem/connector.json
  echo
  warn " This URL changes every restart. For a PERMANENT URL, re-run with:"
  warn "   TANDEM_SETUP_MODE=tailscale ./setup.sh"
  warn " Keep this terminal open. Bridge PID ${BRIDGE_PID}, tunnel PID ${TUNNEL_PID}."
  warn " To stop: kill ${BRIDGE_PID} ${TUNNEL_PID}"
  echo " Logs: .tandem/bridge.log , .tandem/tunnel.log"
  say "──────────────────────────────────────────────────────────────"
  exit 0
fi

# ── 5b. TAILSCALE MODE: persistent Funnel URL ───────────────────────────────
# `funnel --bg` writes the forward (public 443 → local PORT) into tailscaled's
# persisted config and returns: it survives this script, the terminal, and
# reboots. The hostname is the machine's stable MagicDNS name, so the MCP URL
# never changes as long as the machine name, tailnet, and token stay the same.
say "Enabling Tailscale Funnel (public 443 → local ${PORT})…"
: > .tandem/funnel.log
if ! "$TS_BIN" funnel --bg "${PORT}" >.tandem/funnel.log 2>&1; then
  cat .tandem/funnel.log >&2
  FUNNEL_OUT="$(cat .tandem/funnel.log 2>/dev/null || true)"
  echo
  # Order matters: Tailscale's HTTPS-disabled error also starts with
  # "Funnel not available", so match the HTTPS wording first.
  case "$FUNNEL_OUT" in
    *"HTTPS must be enabled"*|*"enable HTTPS"*|*"tailscale.com/s/https"*)
      die "HTTPS certificates are disabled for your tailnet (Funnel needs them).
     Enable them (one toggle): https://login.tailscale.com/admin/dns → 'Enable HTTPS'
     Then re-run ./setup.sh." ;;
    *"node attribute"*|*"Funnel not available"*|*"not allowed"*|*"tailscale.com/s/no-funnel"*)
      die "Your tailnet policy doesn't permit Funnel on this node yet.
     Tailscale usually prints an enable link above — open it (one click), or see
     https://tailscale.com/kb/1223/funnel for the 'funnel' node attribute.
     Then re-run ./setup.sh." ;;
    *"Access denied"*|*operator*)
      die "Funnel needs operator rights for your user.
     Run once:  sudo tailscale up --operator=\$USER   (or re-run setup with sudo)
     Then re-run ./setup.sh." ;;
    *)
      die "tailscale funnel failed (output above).
     Docs: https://tailscale.com/kb/1223/funnel" ;;
  esac
fi

# Read back the stable ts.net hostname: primary = the funnel output itself;
# fallback = the machine's MagicDNS name from `status --json` (no jq — node is
# already a prerequisite).
TS_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.ts\.net' .tandem/funnel.log | head -1 || true)"
if [ -n "$TS_URL" ]; then
  TS_HOST="${TS_URL#https://}"
else
  TS_HOST="$("$TS_BIN" status --json 2>/dev/null \
    | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(((j.Self&&j.Self.DNSName)||"").replace(/\.$/,""))' \
    || true)"
fi
[ -n "$TS_HOST" ] || { cat .tandem/funnel.log >&2; die "could not determine your ts.net hostname (funnel output above)."; }
echo "https://${TS_HOST}" > .tandem/funnel.url

MCP_URL="https://${TS_HOST}/${TOKEN}/mcp"
cat > .tandem/connector.json <<JSON
{
  "name": "tandem",
  "url": "${MCP_URL}"
}
JSON

# Verify end-to-end (DNS + cert + funnel + bridge). First activation can take
# ~30s while the TLS cert is minted, so retry; a miss is a warn, not a fail.
FUNNEL_VERIFY_TRIES="${TANDEM_FUNNEL_VERIFY_TRIES:-15}"
HEALTH_OK=""
if command -v curl >/dev/null 2>&1; then
  say "Verifying https://${TS_HOST}/health (first run can take ~30s while the TLS cert is minted)…"
  for _ in $(seq 1 "$FUNNEL_VERIFY_TRIES"); do
    if curl -fsS --max-time 5 "https://${TS_HOST}/health" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
    sleep 3
  done
fi
if [ -n "$HEALTH_OK" ]; then
  say "✓ funnel is live: https://${TS_HOST}/health answers"
else
  warn "Funnel is configured but not answering yet — certs can take a minute on"
  warn "first use. Check later with: curl https://${TS_HOST}/health"
fi

# ── 6. Report ───────────────────────────────────────────────────────────────
echo
say "──────────────────────────────────────────────────────────────"
say " tandem is live — persistent URL (Tailscale Funnel)"
say "──────────────────────────────────────────────────────────────"
echo " Funnel URL : https://${TS_HOST}"
echo " Token      : ${TOKEN}"
echo " MCP URL    : ${MCP_URL}"
echo
echo " Paste this into Claude.ai → Settings → Connectors → Add custom connector:"
echo
cat .tandem/connector.json
echo
echo " This URL is PERSISTENT: same machine name + same token = same URL after"
echo " every restart. Re-running ./setup.sh just re-attaches to it."
echo
warn " The funnel itself is daemon-owned (it survives reboots); only the bridge"
warn " runs from this setup. Bridge PID ${BRIDGE_PID}."
warn " Stop sharing:  tailscale funnel reset    (and: kill \$(cat .tandem/bridge.pid))"
echo " Logs: .tandem/bridge.log , .tandem/funnel.log"
say "──────────────────────────────────────────────────────────────"
