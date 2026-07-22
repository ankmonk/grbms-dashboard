#!/usr/bin/env python3
"""
Upload all station & WRIS data files to private Cloudflare R2 bucket.
No data is ever pushed to GitHub.
"""

import os
import glob
import requests

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "c9c834d310acf30208db542eebb7921c")
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
BUCKET = "grbms-data"

BASE_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets/{BUCKET}/objects"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json"
}

def upload_file(key, filepath):
    with open(filepath, "rb") as f:
        content = f.read()
    url = f"{BASE_URL}/{key}"
    res = requests.put(url, headers=HEADERS, data=content)
    if res.status_code == 200 and res.json().get("success"):
        size_kb = len(content) / 1024
        print(f"  ✅ Uploaded: {key} ({size_kb:.1f} KB)")
        return True
    else:
        print(f"  ❌ Failed {key}: {res.status_code} {res.text}")
        return False

def main():
    print("\n╔══════════════════════════════════════════════════════╗")
    print("║   Uploading Dataset to Private Cloudflare R2 Bucket   ║")
    print("╚══════════════════════════════════════════════════════╝\n")

    # 1. Upload index.json
    print("▶ Uploading root index.json ...")
    upload_file("index.json", "site/data/index.json")

    # 2. Upload stations
    station_files = sorted(glob.glob("site/data/stations/*.json"))
    print(f"\n▶ Uploading {len(station_files)} station files to 'stations/' in R2 ...")
    for filepath in station_files:
        filename = os.path.basename(filepath)
        upload_file(f"stations/{filename}", filepath)

    # 3. Upload WRIS data
    wris_files = sorted(glob.glob("site/data/wris/*.json"))
    print(f"\n▶ Uploading {len(wris_files)} WRIS files to 'wris/' in R2 ...")
    for filepath in wris_files:
        filename = os.path.basename(filepath)
        upload_file(f"wris/{filename}", filepath)

    print("\n" + "═" * 56)
    print("  🎉 Upload Complete: Station & WRIS files uploaded to R2!")
    print(f"  Bucket: {BUCKET} (Private - zero public egress fees)")
    print("═" * 56 + "\n")

if __name__ == "__main__":
    main()
