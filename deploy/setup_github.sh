#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  setup_github.sh
#  Initialises the git repository and pushes the site to GitHub Pages.
#  Run this AFTER you have:
#    1. Created a GitHub repo (github.com → New repository → grbms-dashboard)
#    2. Updated WORKER_URL in site/app.js with your real Worker URL
#
#  Usage:
#    bash deploy/setup_github.sh YOUR_GITHUB_USERNAME
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

GITHUB_USER="${1:-}"

if [ -z "$GITHUB_USER" ]; then
  echo "Usage: bash deploy/setup_github.sh YOUR_GITHUB_USERNAME"
  exit 1
fi

REPO_URL="https://github.com/${GITHUB_USER}/grbms-dashboard.git"
ROOT_DIR="$(dirname "$0")/.."

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   GRBMS → GitHub Pages Setup                         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  GitHub user : ${GITHUB_USER}"
echo "  Repo URL    : ${REPO_URL}"
echo ""

cd "$ROOT_DIR"

# Verify WORKER_URL has been set
if grep -q "__WORKER_URL__" site/app.js; then
  echo "❌  You must update WORKER_URL in site/app.js first!"
  echo "    Replace __WORKER_URL__ with your real Worker URL."
  echo "    Example: const WORKER_URL = \"https://grbms-worker.abc.workers.dev\";"
  exit 1
fi

# Initialise git if needed
if [ ! -d ".git" ]; then
  echo "▶  Initialising git repository …"
  git init
  git branch -M main
fi

# Configure what to push
echo "▶  Staging files (data/ is excluded by .gitignore) …"
git add \
  site/index.html \
  site/app.js \
  site/style.css \
  site/wris.html \
  "site/vendor/" \
  "site/data/ganga_basin.geojson" \
  deploy/ \
  .gitignore \
  pipeline/ \
  README.md 2>/dev/null || true

git status --short

echo ""
echo "▶  Committing …"
git commit -m "Deploy GRBMS dashboard — Cloudflare Worker + GitHub Pages" --allow-empty

# Set remote
if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

echo ""
echo "▶  Pushing to GitHub …"
git push -u origin main

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Pushed to GitHub!"
echo ""
echo "  Now enable GitHub Pages:"
echo "  → github.com/${GITHUB_USER}/grbms-dashboard"
echo "  → Settings → Pages → Source: Deploy from branch"
echo "  → Branch: main  /  Folder: /site"
echo ""
echo "  Your dashboard will be live at:"
echo "  → https://${GITHUB_USER}.github.io/grbms-dashboard/"
echo "═══════════════════════════════════════════════════════"
echo ""
