#!/bin/bash
# ============================================================
# Block Vault Systems — ngrok Tunnel Setup
# Camera 2 — Run ONCE on Jomari's Mac
# ============================================================
# Prerequisites:
#   1. Sign up free at https://ngrok.com (separate account from Andrew)
#   2. Get authtoken from: https://dashboard.ngrok.com/authtokens
#   3. Get free static domain from: https://dashboard.ngrok.com/domains
# ============================================================

set -e

NGROK_AUTHTOKEN="PASTE_YOUR_AUTHTOKEN_HERE"
NGROK_STATIC_DOMAIN="PASTE_YOUR_STATIC_DOMAIN_HERE"
CAM_IP="192.168.X.X"     # ← Jomari's camera IP
CAM_PORT="80"

echo "==> Step 1: Install ngrok"
if ! command -v ngrok &>/dev/null; then
  brew install ngrok
else
  echo "    ngrok already installed: $(ngrok --version)"
fi

echo ""
echo "==> Step 2: Authenticate"
ngrok config add-authtoken "$NGROK_AUTHTOKEN"

echo ""
echo "==> Step 3: Write config"
NGROK_CONFIG="$HOME/.config/ngrok/ngrok.yml"
mkdir -p "$(dirname "$NGROK_CONFIG")"

cat > "$NGROK_CONFIG" << EOF
version: "3"
agent:
  authtoken: ${NGROK_AUTHTOKEN}

tunnels:
  axis-cam-2:
    proto: http
    addr: ${CAM_IP}:${CAM_PORT}
    domain: ${NGROK_STATIC_DOMAIN}
    inspect: false
EOF

echo ""
echo "==> Step 4: Install as system daemon"

PLIST_PATH="/Library/LaunchDaemons/com.blockvault.ngrok.cam2.plist"
NGROK_BIN="$(which ngrok)"

sudo tee "$PLIST_PATH" > /dev/null << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.blockvault.ngrok.cam2</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NGROK_BIN}</string>
    <string>start</string>
    <string>axis-cam-2</string>
    <string>--config</string>
    <string>${HOME}/.config/ngrok/ngrok.yml</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/blockvault-ngrok-cam2.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/blockvault-ngrok-cam2.err.log</string>
</dict>
</plist>
EOF

sudo chmod 644 "$PLIST_PATH"
sudo launchctl load "$PLIST_PATH"
sudo launchctl start com.blockvault.ngrok.cam2

echo ""
echo "============================================================"
echo " DONE. Camera 2 tunnel URL: https://${NGROK_STATIC_DOMAIN}"
echo " Send this URL to Sunil to add to camera-service .env"
echo "============================================================"
