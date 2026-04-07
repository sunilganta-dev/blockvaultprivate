#!/bin/bash
# ============================================================
# Block Vault Systems — Cloudflare Tunnel Setup
# Run this ONCE on Andrew's Mac
# ============================================================

set -e

TUNNEL_NAME="blockvault-axis-cam-1"
CAM_HOSTNAME="cam1.YOUR_DOMAIN.com"   # ← replace with your domain

echo "==> Step 1: Install cloudflared"
if ! command -v cloudflared &>/dev/null; then
  brew install cloudflared
else
  echo "    cloudflared already installed: $(cloudflared --version)"
fi

echo ""
echo "==> Step 2: Authenticate with Cloudflare"
echo "    A browser window will open — log in and select your domain."
cloudflared tunnel login

echo ""
echo "==> Step 3: Create named tunnel"
cloudflared tunnel create "$TUNNEL_NAME"

echo ""
echo "==> Step 4: Copy credentials to system location"
sudo mkdir -p /etc/cloudflared
CRED_FILE=$(ls ~/.cloudflared/*.json | head -1)
sudo cp "$CRED_FILE" /etc/cloudflared/${TUNNEL_NAME}.json
sudo chmod 600 /etc/cloudflared/${TUNNEL_NAME}.json

echo ""
echo "==> Step 5: Install config"
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml > /dev/null << EOF
tunnel: ${TUNNEL_NAME}
credentials-file: /etc/cloudflared/${TUNNEL_NAME}.json

ingress:
  - hostname: ${CAM_HOSTNAME}
    service: http://${CAM_IP}
    originRequest:
      noTLSVerify: true
      connectTimeout: 10s
      tcpKeepAlive: 30s
      keepAliveTimeout: 90s
      keepAliveConnections: 100
  - service: http_status:404
EOF

echo ""
echo "==> Step 6: Route DNS — maps cam1.YOUR_DOMAIN.com → this tunnel"
cloudflared tunnel route dns "$TUNNEL_NAME" "$CAM_HOSTNAME"

echo ""
echo "==> Step 7: Install as system daemon (auto-starts at boot, no login needed)"
sudo cloudflared service install

echo ""
echo "==> Step 8: Start the service now"
sudo launchctl start com.cloudflare.cloudflared

echo ""
echo "============================================================"
echo " DONE. Tunnel is running as a system service."
echo " Camera accessible at: https://${CAM_HOSTNAME}"
echo ""
echo " Useful commands:"
echo "   Status:   sudo launchctl list | grep cloudflared"
echo "   Logs:     sudo tail -f /Library/Logs/com.cloudflare.cloudflared.err.log"
echo "   Stop:     sudo launchctl stop com.cloudflare.cloudflared"
echo "   Restart:  sudo launchctl kickstart -k system/com.cloudflare.cloudflared"
echo "============================================================"
