#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  upload_data_to_r2.sh
#  Uploads the station JSON files from site/data/ to the private Cloudflare R2
#  bucket (grbms-data).  Run this once after build_site.py completes, and again
#  whenever you regenerate the data.
#
#  Requirements:
#    npm install -g wrangler
#    wrangler login          (opens browser once)
#
#  Usage:
#    cd ganga-dashboard
#    bash deploy/upload_data_to_r2.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

BUCKET="grbms-data"
DATA_DIR="$(dirname "$0")/../site/data"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   GRBMS → Cloudflare R2 Data Upload                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Check wrangler is available
if ! command -v wrangler &>/dev/null; then
  echo "❌  wrangler not found."
  echo "    Install it with:  npm install -g wrangler"
  exit 1
fi

# Upload index.json
echo "▶  Uploading index.json …"
wrangler r2 object put "${BUCKET}/index.json" \
  --file="${DATA_DIR}/index.json" \
  --content-type="application/json"
echo "   ✅ index.json"

# Upload all station files
STATION_DIR="${DATA_DIR}/stations"
if [ ! -d "$STATION_DIR" ]; then
  echo "❌  stations/ folder not found at: ${STATION_DIR}"
  echo "    Run pipeline/build_site.py first."
  exit 1
fi

count=0
for f in "${STATION_DIR}"/*.json; do
  name=$(basename "$f")
  wrangler r2 object put "${BUCKET}/stations/${name}" \
    --file="$f" \
    --content-type="application/json"
  echo "   ✅ stations/${name}"
  ((count++))
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Upload complete: ${count} station files + index.json"
echo "  Bucket: ${BUCKET} (private — no public URL)"
echo "═══════════════════════════════════════════════════════"
echo ""
