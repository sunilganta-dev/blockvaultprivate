#!/bin/bash
# ============================================================
# Block Vault Systems — Cloudflare Tunnel Setup
# Run this ONCE on Jomari's Mac (Camera 2)
# ============================================================

set -e

TUNNEL_NAME="blockvault-axis-cam-2"
CAM_HOSTNAME="cam2.YOUR_DOMAIN.com"   # ← replace with your domain
CAM_IP="192.168.X.X"                  # ← replace with Jomari's camera IP

echo "==> Step 1: Install cloudflared"
if ! command -v cloudflared &>/dev/null; then
  brew install cloudflared
else
  echo "    cloudflared already installed: $(cloudflared --version)"
fi

echo ""
echo "==> Step 2: Authenticate with Cloudflare"
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
echo "==> Step 6: Route DNS"
cloudflared tunnel route dns "$TUNNEL_NAME" "$CAM_HOSTNAME"

echo ""
echo "==> Step 7: Install as system daemon"
sudo cloudflared service install

echo ""
echo "==> Step 8: Start service"
sudo launchctl start com.cloudflare.cloudflared

echo ""
echo "============================================================"
echo " DONE. Camera 2 accessible at: https://${CAM_HOSTNAME}"
echo "============================================================"
