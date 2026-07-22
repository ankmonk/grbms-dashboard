# GRBMS — Ganga River Basin Monitoring System

**Ankit Bara · IIT BHU · Carbon Flux Research**

A secure, private research dashboard for monitoring water quality, water surface elevation, and CO₂ flux across the Ganga River Basin.

## Architecture

```
GitHub Pages (public UI)
    ↓  authenticated API calls
Cloudflare Worker (JWT gateway, rate limiter)
    ↓  private R2 reads only
Cloudflare R2 (private data bucket — no public URL)
```

**Cost: ₹0/month** (within Cloudflare free tier)

## Deployment (One-Time Setup)

### Prerequisites
```bash
# Install Node.js first, then:
npm install -g wrangler
wrangler login       # opens browser — log in with your Cloudflare account
```

### Step 1 — Create Cloudflare R2 Bucket
1. Go to cloudflare.com → R2 → Create bucket
2. Name: `grbms-data`
3. Leave public access OFF

### Step 2 — Deploy the Worker (API Gateway)
```bash
bash deploy/deploy_worker.sh
# → Enter a JWT secret when prompted (run: openssl rand -hex 32 to generate one)
# → Enter your dashboard password for username "ankit"
# → Copy the Worker URL printed at the end
```

### Step 3 — Set Worker URL in app.js
Edit `site/app.js` line 10:
```javascript
const WORKER_URL = "https://grbms-worker.YOUR_SUBDOMAIN.workers.dev";
```

### Step 4 — Upload Data to R2
```bash
# First run the pipeline to build the JSON files:
python3 pipeline/build_site.py

# Then upload to private R2 bucket:
bash deploy/upload_data_to_r2.sh
```

### Step 5 — Push to GitHub Pages
1. Create a GitHub repo named `grbms-dashboard` at github.com
2. Run:
```bash
bash deploy/setup_github.sh YOUR_GITHUB_USERNAME
```
3. Go to repo Settings → Pages → Source: `main` branch, `/site` folder
4. Your dashboard will be live at: `https://YOUR_USERNAME.github.io/grbms-dashboard/`

## Updating Data

Whenever you run `build_site.py` with new data:
```bash
python3 pipeline/build_site.py
bash deploy/upload_data_to_r2.sh
```

No need to re-push to GitHub — the UI is static.

## Security

- Data files have **no public URL** — all access goes through the Worker
- Worker validates JWT tokens on every request
- Rate limited to 60 requests/minute per user
- Token expires after 24 hours (forces re-login)
- Secrets (JWT key, password) stored in Cloudflare — never in code
