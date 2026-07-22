#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  deploy_worker.sh
#  Deploys (or re-deploys) the Cloudflare Worker and sets secrets.
#  Run this once after creating the Cloudflare account and R2 bucket.
#
#  Requirements:
#    npm install -g wrangler
#    wrangler login
#
#  Usage:
#    bash deploy/deploy_worker.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

WORKER_DIR="$(dirname "$0")/cloudflare-worker"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   GRBMS → Cloudflare Worker Deployment               ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Check wrangler
if ! command -v wrangler &>/dev/null; then
  echo "❌  wrangler not found.  Run: npm install -g wrangler"
  exit 1
fi

cd "$WORKER_DIR"

# Install npm deps if needed
if [ ! -d node_modules ]; then
  echo "▶  Installing wrangler dependency …"
  npm install
fi

# Set the JWT secret (interactive — you type it once, it's stored securely in Cloudflare)
echo ""
echo "Step 1/2 — Set JWT secret (stored securely in Cloudflare, NOT in your code)"
echo "           Enter any long random string (e.g. 64 random characters)."
echo "           Example: openssl rand -hex 32"
echo ""
wrangler secret put JWT_SECRET

# Set your password
echo ""
echo "Step 2/2 — Set your login password for username 'ankit'"
echo "           This is stored as a Cloudflare secret, not in code."
echo ""
wrangler secret put PASSWORD_ankit

# Deploy the worker
echo ""
echo "▶  Deploying worker …"
wrangler deploy

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Worker deployed!"
echo ""
echo "  Your Worker URL is shown above (ends in .workers.dev)"
echo "  Copy that URL and update WORKER_URL in site/app.js"
echo "═══════════════════════════════════════════════════════"
echo ""
