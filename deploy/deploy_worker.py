#!/usr/bin/env python3
"""
Deploy Cloudflare Worker API gateway with R2 binding.
"""

import json
import os
import requests

ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "c9c834d310acf30208db542eebb7921c")
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
SCRIPT_NAME = "grbms-worker"
BUCKET_NAME = "grbms-data"

def deploy_worker():
    print("\n╔══════════════════════════════════════════════════════╗")
    print("║   Deploying Cloudflare Worker API Gateway            ║")
    print("╚══════════════════════════════════════════════════════╝\n")

    # Read worker code
    with open("deploy/cloudflare-worker/src/index.js", "r") as f:
        worker_code = f.read()

    # Worker metadata definition
    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2024-09-23",
        "bindings": [
            {
                "name": "GRBMS_BUCKET",
                "type": "r2_bucket",
                "bucket_name": BUCKET_NAME
            }
        ]
    }

    files = {
        "metadata": (None, json.dumps(metadata), "application/json"),
        "index.js": ("index.js", worker_code, "application/javascript+module")
    }

    headers = {
        "Authorization": f"Bearer {TOKEN}"
    }

    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}"
    
    print(f"▶ Uploading Worker '{SCRIPT_NAME}' to Cloudflare...")
    res = requests.put(url, headers=headers, files=files)
    
    print("Response Code:", res.status_code)
    print("Response JSON:", res.json())

    if res.status_code == 200 and res.json().get("success"):
        # Enable workers.dev subdomain route
        sub_url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/{SCRIPT_NAME}/subdomain"
        res_sub = requests.post(sub_url, headers=headers, json={"enabled": True})
        print("\n▶ Enabling workers.dev route:", res_sub.status_code, res_sub.json())

        worker_url = f"https://{SCRIPT_NAME}.ankitbara76.workers.dev"
        print(f"\n🎉 Worker deployed successfully!")
        print(f"   API Gateway URL: {worker_url}")
        return worker_url
    else:
        print("❌ Worker deployment failed!")
        return None

if __name__ == "__main__":
    deploy_worker()
