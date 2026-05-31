#!/usr/bin/env bash
#
# tandem one-command setup.
#
# Gives YOU your own bridge: your own random token, your own free Cloudflare
# quick tunnel. It never reuses anyone else's URL or token, and never contacts
# any third-party account — the quick tunnel is anonymous and free.
#
#   ./setup.sh
#
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT="${TANDEM_PORT:-8787}"
HOST="127.0.0.1"

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

say "tandem setup"
echo

# ── 1. Prerequisites ────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die \
  "node is not installed. Install Node 22.6+ from https://nodejs.org (or: brew install node)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".").map(Number)[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".").map(Number)[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  die "Node $(node -v) is too old. tandem needs >= 22.6 (it runs TypeScript via native type-stripping)."
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  die "cloudflared is not installed. Install it, then re-run ./setup.sh
       macOS:  brew install cloudflared
       other:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
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

say "✓ node $(node -v), cloudflared, tmux present"

# ── 2. Dependencies ─────────────────────────────────────────────────────────
say "Installing dependencies (npm install)…"
npm install --silent

# ── 3. .env with a FRESH token ──────────────────────────────────────────────
[ -f .env ] || cp .env.example .env

gen_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  fi
}

# Read current value (if any) from .env
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

# ── 4. Start the bridge ─────────────────────────────────────────────────────
mkdir -p .tandem
say "Starting the bridge on http://${HOST}:${PORT}…"
node --experimental-strip-types src/server.ts >.tandem/bridge.log 2>&1 &
BRIDGE_PID=$!
echo "$BRIDGE_PID" > .tandem/bridge.pid
sleep 2
if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
  cat .tandem/bridge.log >&2
  die "bridge failed to start (see output above)."
fi

# ── 5. Start YOUR OWN quick tunnel ──────────────────────────────────────────
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

# ── 6. Report ───────────────────────────────────────────────────────────────
echo
say "──────────────────────────────────────────────────────────────"
say " tandem is live"
say "──────────────────────────────────────────────────────────────"
echo " Tunnel URL : ${TUNNEL_URL}"
echo " Token      : ${TOKEN}"
echo " MCP URL    : ${MCP_URL}"
echo
echo " Paste this into Claude.ai → Settings → Connectors → Add custom connector:"
echo
cat .tandem/connector.json
echo
warn " Keep this terminal open. Bridge PID ${BRIDGE_PID}, tunnel PID ${TUNNEL_PID}."
warn " To stop: kill ${BRIDGE_PID} ${TUNNEL_PID}"
echo " Logs: .tandem/bridge.log , .tandem/tunnel.log"
say "──────────────────────────────────────────────────────────────"
