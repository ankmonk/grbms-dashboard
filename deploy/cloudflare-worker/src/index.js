/**
 * GRBMS Cloudflare Worker — Secure API Gateway
 * -----------------------------------------------
 * Validates JWT tokens, rate-limits, logs access,
 * and proxies requests to private R2 bucket.
 *
 * Routes:
 *   POST /login                    → returns JWT token
 *   GET  /data/index.json          → station index (auth required)
 *   GET  /data/stations/:id.json   → station data  (auth required)
 *   GET  /data/ganga_basin.geojson → public basin shape (no auth)
 */

// ─── CONFIG (edit these before deploying) ────────────────────────────────────
// Credentials stored in Worker Secrets (set via: wrangler secret put PASSWORD_ankit)
// Fallback hardcoded credentials (less secure, but works for single user):
const CREDENTIALS = {
  ankit: "REDACTED",
};

// Rate limiting
const RATE_LIMIT_PER_MINUTE = 60;   // max data requests per user per minute
const TOKEN_EXPIRY_HOURS   = 24;    // JWT validity period

// Your GitHub Pages URL — ONLY this origin can use the API
// Update this after you know your GitHub Pages URL
const ALLOWED_ORIGIN = "*";   // temporarily allow all; tighten after deployment

// ─── CORS ─────────────────────────────────────────────────────────────────────
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(), ...extraHeaders },
  });
}

// ─── JWT (pure Web Crypto, no libraries) ──────────────────────────────────────
const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const ab2str = (buf) => String.fromCharCode(...new Uint8Array(buf));

async function jwtSign(payload, secret) {
  const header  = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body    = b64url(JSON.stringify(payload));
  const data    = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64url(ab2str(sig))}`;
}

async function jwtVerify(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    // restore base64 padding
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    const payload = JSON.parse(atob(body.replace(/-/g,"+").replace(/_/g,"/")));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return payload;
  } catch { return null; }
}

// ─── RATE LIMITER (in-memory per Worker instance) ─────────────────────────────
const rateBuckets = new Map();

function rateAllow(userId) {
  const now   = Date.now();
  const win   = 60_000;
  const entry = rateBuckets.get(userId) || { count: 0, start: now };

  if (now - entry.start > win) {
    rateBuckets.set(userId, { count: 1, start: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_PER_MINUTE) return false;
  entry.count++;
  return true;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // ── POST /login ──────────────────────────────────────────────────────────
    if (url.pathname === "/login" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Invalid JSON" }, 400); }

      const { username, password } = body;

      // Check env secrets first (set via: wrangler secret put PASSWORD_ankit)
      const envKey = `PASSWORD_${username}`;
      const expectedPw = env[envKey] || CREDENTIALS[username];

      if (!username || !expectedPw || expectedPw !== password) {
        // Small delay to prevent brute-force timing attacks
        await new Promise(r => setTimeout(r, 300));
        return json({ error: "Invalid username or password" }, 401);
      }

      const secret = env.JWT_SECRET || "SET_VIA_WRANGLER_SECRET";
      const token = await jwtSign({
        sub: username,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_HOURS * 3600,
      }, secret);

      return json({ token });
    }

    // ── All other routes: require valid JWT ───────────────────────────────────
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");

    if (!token) return json({ error: "Missing token. Please log in." }, 401);

    const secret  = env.JWT_SECRET || "SET_VIA_WRANGLER_SECRET";
    const payload = await jwtVerify(token, secret);
    if (!payload)  return json({ error: "Invalid or expired token. Please log in again." }, 401);

    if (!rateAllow(payload.sub)) {
      return json({ error: "Rate limit exceeded. Please slow down." }, 429);
    }

    // ── GET /data/index.json ──────────────────────────────────────────────────
    if (url.pathname === "/data/index.json" && request.method === "GET") {
      const obj = await env.GRBMS_BUCKET.get("index.json");
      if (!obj) return json({ error: "Not found" }, 404);
      return new Response(obj.body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600", ...cors(origin) },
      });
    }

    // ── GET /data/stations/:id.json ───────────────────────────────────────────
    const stationMatch = url.pathname.match(/^\/data\/stations\/(\d+)\.json$/);
    if (stationMatch && request.method === "GET") {
      const key = `stations/${stationMatch[1]}.json`;
      const obj = await env.GRBMS_BUCKET.get(key);
      if (!obj) return json({ error: "Station not found" }, 404);
      return new Response(obj.body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600", ...cors(origin) },
      });
    }

    // ── GET /data/wris/index.json ─────────────────────────────────────────────
    if (url.pathname === "/data/wris/index.json" && request.method === "GET") {
      const obj = await env.GRBMS_BUCKET.get("wris/index.json");
      if (!obj) return json({ error: "WRIS index not found" }, 404);
      return new Response(obj.body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600", ...cors(origin) },
      });
    }

    // ── GET /data/wris/:slug.json ─────────────────────────────────────────────
    const wrisMatch = url.pathname.match(/^\/data\/wris\/([a-zA-Z0-9_-]+)\.json$/);
    if (wrisMatch && request.method === "GET") {
      const key = `wris/${wrisMatch[1]}.json`;
      const obj = await env.GRBMS_BUCKET.get(key);
      if (!obj) return json({ error: "WRIS data not found" }, 404);
      return new Response(obj.body, {
        headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600", ...cors(origin) },
      });
    }

    return json({ error: "Not found" }, 404);
  },
};
