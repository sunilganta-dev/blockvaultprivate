#!/bin/bash
# ============================================================
# Block Vault Systems — ngrok Tunnel Setup
# Camera 1 — Run ONCE on Andrew's Mac
# ============================================================
# Prerequisites:
#   1. Sign up free at https://ngrok.com
#   2. Get your authtoken from: https://dashboard.ngrok.com/authtokens
#   3. Get your free static domain from: https://dashboard.ngrok.com/domains
#      (one free domain per account, looks like: xyz-abc-123.ngrok-free.app)
#
# Fill in the two variables below then run:
#   chmod +x setup-ngrok-andrew.sh && ./setup-ngrok-andrew.sh
# ============================================================

set -e

NGROK_AUTHTOKEN="<YOUR_NGROK_AUTHTOKEN>"
NGROK_STATIC_DOMAIN="<YOUR_NGROK_STATIC_DOMAIN>"   # e.g. xyz-abc-123.ngrok-free.app
CAM_IP="<CAMERA_IP>"
CAM_PORT="80"

# ── Install ngrok ─────────────────────────────────────────────────────────────
echo "==> Step 1: Install ngrok"
if ! command -v ngrok &>/dev/null; then
  brew install ngrok
else
  echo "    ngrok already installed: $(ngrok --version)"
fi

# ── Authenticate ──────────────────────────────────────────────────────────────
echo ""
echo "==> Step 2: Authenticate ngrok"
ngrok config add-authtoken "$NGROK_AUTHTOKEN"

# ── Write config ──────────────────────────────────────────────────────────────
echo ""
echo "==> Step 3: Write ngrok config"
NGROK_CONFIG="$HOME/.config/ngrok/ngrok.yml"
mkdir -p "$(dirname "$NGROK_CONFIG")"

cat > "$NGROK_CONFIG" << EOF
version: "3"
agent:
  authtoken: ${NGROK_AUTHTOKEN}

tunnels:
  axis-cam-1:
    proto: http
    addr: ${CAM_IP}:${CAM_PORT}
    domain: ${NGROK_STATIC_DOMAIN}
    inspect: false
EOF

echo "    Config written to $NGROK_CONFIG"

# ── Install as system LaunchDaemon (auto-start at boot, no login needed) ──────
echo ""
echo "==> Step 4: Install as system daemon"

PLIST_PATH="/Library/LaunchDaemons/com.blockvault.ngrok.cam1.plist"
NGROK_BIN="$(which ngrok)"

sudo tee "$PLIST_PATH" > /dev/null << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.blockvault.ngrok.cam1</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NGROK_BIN}</string>
    <string>start</string>
    <string>axis-cam-1</string>
    <string>--config</string>
    <string>${HOME}/.config/ngrok/ngrok.yml</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/var/log/blockvault-ngrok-cam1.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/blockvault-ngrok-cam1.err.log</string>
</dict>
</plist>
EOF

sudo chmod 644 "$PLIST_PATH"

# ── Start daemon ──────────────────────────────────────────────────────────────
echo ""
echo "==> Step 5: Start daemon"
sudo launchctl load "$PLIST_PATH"
sudo launchctl start com.blockvault.ngrok.cam1

sleep 3

# ── Verify ────────────────────────────────────────────────────────────────────
echo ""
echo "==> Step 6: Verify tunnel is live"
curl -s "https://${NGROK_STATIC_DOMAIN}/axis-cgi/jpg/image.cgi" \
  --digest -u root: -o /dev/null -w "HTTP status: %{http_code}\n" || true

echo ""
echo "============================================================"
echo " DONE. Camera tunnel running as system daemon."
echo ""
echo " Tunnel URL: https://${NGROK_STATIC_DOMAIN}"
echo " MJPEG feed: https://${NGROK_STATIC_DOMAIN}/mjpg/video.mjpg"
echo ""
echo " Useful commands:"
echo "   Status:  sudo launchctl list | grep blockvault"
echo "   Logs:    sudo tail -f /var/log/blockvault-ngrok-cam1.log"
echo "   Stop:    sudo launchctl stop com.blockvault.ngrok.cam1"
echo "   Restart: sudo launchctl kickstart -k system/com.blockvault.ngrok.cam1"
echo "============================================================"
