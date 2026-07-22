/* Ganga Basin Water Quality Dashboard
   Static UI on GitHub Pages; data served via Cloudflare Worker (private R2 bucket). */

const $ = (s) => document.querySelector(s);
const SERIES = (n) => `var(--series-${((n) % 8) + 1})`;

// ── Cloudflare Worker base URL ─────────────────────────────────────────────
const WORKER_URL = "https://grbms-worker.ankitbara76.workers.dev";

// ── Secure fetch — automatically attaches JWT token ────────────────────────
async function secureFetch(path) {
  const token = sessionStorage.getItem("grbms_token");
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: token ? { "Authorization": `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    // Token expired or invalid → force re-login
    sessionStorage.removeItem("grbms_token");
    showLoginScreen();
    throw new Error("Session expired. Please log in again.");
  }
  return res.json();
}

// ── Show / hide login screen ────────────────────────────────────────────────
function showLoginScreen() {
  const ls = document.getElementById("login-screen");
  const hdr = document.querySelector("header");
  const wrap = document.querySelector(".wrap");
  if (ls)   ls.style.display  = "flex";
  if (hdr)  hdr.style.display = "none";
  if (wrap) wrap.style.display = "none";
}

function hideLoginScreen() {
  const ls = document.getElementById("login-screen");
  const hdr = document.querySelector("header");
  const wrap = document.querySelector(".wrap");
  if (ls)   ls.style.display  = "none";
  if (hdr)  hdr.style.display = "flex";
  if (wrap) wrap.style.display = "grid";
  // Leaflet needs a tick to measure the now-visible container
  setTimeout(() => { if (mapObj) mapObj.invalidateSize(); }, 120);
}

const state = {
  index: null,
  station: null,     // observed payload for the selected station
  imputed: null,     // imputed sidecar, lazy-loaded only when showImputed is on
  stationId: null,
  param: null,
  days: 0,           // 0 = all
  stretch: "",
  selectedState: "",
  showImputed: false, // observed is the default; imputed is opt-in
  smoothAlgo: "none",
  smoothSpan: 15,
};

const impCache = new Map(); // station_id -> imputed payload (or null if none)

let mapObj = null;
let geoJsonLayer = null;
let markersLayer = null;

/* ---------------- data access ---------------- */

// Blocks are packed onto shared time axes: {t0, t:[minutes], v:{param:[…]}}.
// A block holds a single kind of data — observed OR imputed — never both.
function unpack(block, param) {
  if (!block || !block.v[param]) return null;
  const t0 = new Date(block.t0 + ":00").getTime();
  const vals = block.v[param];
  const pts = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === null) continue;
    pts.push([t0 + block.t[i] * 60000, vals[i]]);
  }
  return pts.length ? pts : null;
}

// The imputed fills for one param, if the sidecar is loaded and the toggle is on.
function unpackImputed(blockName, param) {
  if (!state.showImputed || !state.imputed) return null;
  const blk = state.imputed.blocks?.[blockName];
  return blk ? windowed(unpack(blk, param)) : null;
}

function windowed(pts) {
  if (!pts || !state.days) return pts;
  const end = pts[pts.length - 1][0];
  const cut = end - state.days * 86400000;
  return pts.filter((p) => p[0] >= cut);
}

// MATLAB Curve Fitting Toolbox Algorithms

function ema(pts, alpha = 0.15) {
  if (!pts || !pts.length) return pts;
  const out = [];
  let currentVal = pts[0][1];
  out.push([pts[0][0], currentVal, pts[0][2]]);
  for (let i = 1; i < pts.length; i++) {
    currentVal = alpha * pts[i][1] + (1 - alpha) * currentVal;
    out.push([pts[i][0], currentVal, pts[i][2]]);
  }
  return out;
}

function sma(pts, span = 15) {
  if (!pts || pts.length < span) return pts;
  const out = [];
  const half = Math.floor(span / 2);
  for (let i = 0; i < pts.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(pts.length - 1, i + half);
    let sum = 0, count = 0;
    for (let j = start; j <= end; j++) {
      sum += pts[j][1];
      count++;
    }
    out.push([pts[i][0], sum / count, pts[i][2]]);
  }
  return out;
}

function lowess(pts, span = 15) {
  if (!pts || pts.length < 3) return pts;
  const k = Math.min(span, pts.length);
  const half = Math.floor(k / 2);
  const out = [];

  for (let i = 0; i < pts.length; i++) {
    const x0 = pts[i][0];
    const start = Math.max(0, i - half);
    const end = Math.min(pts.length - 1, i + half);
    
    let maxDist = 0;
    for (let j = start; j <= end; j++) {
      const d = Math.abs(pts[j][0] - x0);
      if (d > maxDist) maxDist = d;
    }
    if (maxDist === 0) maxDist = 1;

    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (let j = start; j <= end; j++) {
      const u = Math.abs(pts[j][0] - x0) / maxDist;
      const w = u < 1 ? Math.pow(1 - Math.pow(u, 3), 3) : 0;
      const xj = pts[j][0] - x0;
      const yj = pts[j][1];

      sw += w;
      swx += w * xj;
      swy += w * yj;
      swxx += w * xj * xj;
      swxy += w * xj * yj;
    }

    const denom = sw * swxx - swx * swx;
    let yHat = pts[i][1];
    if (Math.abs(denom) > 1e-12) {
      const a = (swy * swxx - swx * swxy) / denom;
      yHat = a;
    } else if (sw > 0) {
      yHat = swy / sw;
    }

    out.push([pts[i][0], yHat, pts[i][2]]);
  }
  return out;
}

function savitzkyGolay(pts, span = 15) {
  if (!pts || pts.length < 5) return pts;
  let windowSize = Math.max(5, span % 2 === 0 ? span + 1 : span);
  const half = Math.floor(windowSize / 2);
  const out = [];

  for (let i = 0; i < pts.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(pts.length - 1, i + half);
    
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    let sy0 = 0, sy1 = 0, sy2 = 0;

    for (let j = start; j <= end; j++) {
      const x = j - i;
      const y = pts[j][1];
      const x2 = x * x;
      s0 += 1;
      s1 += x;
      s2 += x2;
      s3 += x * x2;
      s4 += x2 * x2;

      sy0 += y;
      sy1 += x * y;
      sy2 += x2 * y;
    }

    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s2 * s3) + s2 * (s1 * s3 - s2 * s2);
    let fitted = pts[i][1];
    if (Math.abs(det) > 1e-10) {
      const c0 = (sy0 * (s2 * s4 - s3 * s3) - sy1 * (s1 * s4 - s2 * s3) + sy2 * (s1 * s3 - s2 * s2)) / det;
      fitted = c0;
    } else {
      fitted = sy0 / s0;
    }
    out.push([pts[i][0], fitted, pts[i][2]]);
  }
  return out;
}

function applySmoothing(pts, algo, span) {
  if (!pts || !pts.length || algo === "none") return pts;
  if (algo === "ema") return ema(pts, 0.15);
  if (algo === "sma") return sma(pts, span);
  if (algo === "lowess") return lowess(pts, span);
  if (algo === "sgolay") return savitzkyGolay(pts, span);
  return pts;
}

// Preserve visual extremes: keep min & max per pixel bucket rather than sampling.

// Preserve visual extremes: keep min & max per pixel bucket rather than sampling.
function decimate(pts, width) {
  const budget = Math.max(width * 2, 400);
  if (pts.length <= budget) return pts;
  const buckets = Math.floor(budget / 2);
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const span = (t1 - t0) || 1;
  const out = [];
  let bi = 0, lo = null, hi = null;
  for (const p of pts) {
    const b = Math.min(buckets - 1, Math.floor(((p[0] - t0) / span) * buckets));
    if (b !== bi) {
      if (lo) out.push(lo, hi);
      bi = b; lo = hi = p;
    } else {
      if (!lo || p[1] < lo[1]) lo = p;
      if (!hi || p[1] > hi[1]) hi = p;
    }
  }
  if (lo) out.push(lo, hi);
  return out.sort((a, b) => a[0] - b[0]);
}

/* ---------------- scales & formatting ---------------- */

const fmtN = (v) => {
  const a = Math.abs(v);
  if (a >= 10000) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
};
const fmtD = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtDT = (t) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Robust y-domain from the 0.5-99.5 percentile band.
 *
 * Both the CWC WSE feed and the derived pCO2 series carry sensor spikes that
 * are orders of magnitude off (WSE of 4000 m, pCO2 of 4e6 uatm). Scaling to
 * the raw min/max flattens the real signal into a line. Points outside the
 * band are still drawn - they just run off the panel - and the count is
 * reported so nothing is silently hidden.
 */
function robustDomain(series) {
  const all = [];
  for (const s of series) for (const p of s.pts) all.push(p[1]);
  if (!all.length) return null;
  all.sort((a, b) => a - b);
  const q = (f) => all[Math.min(all.length - 1, Math.max(0, Math.floor(all.length * f)))];
  let lo = q(0.005), hi = q(0.995);
  if (lo === hi) { lo = all[0]; hi = all[all.length - 1]; }
  const clipped = all.filter((v) => v < lo || v > hi).length;
  return { lo, hi, clipped, total: all.length };
}

function niceTicks(lo, hi, n = 5) {
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
  return out;
}

function timeTicks(t0, t1, n = 6) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(t0 + ((t1 - t0) * i) / n);
  return out;
}

/* ---------------- chart ---------------- */

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

/**
 * Draw one or more time series on a single shared y-axis.
 * Deliberately never dual-axis: measures of different scale get their own panel.
 */
function drawChart(svg, series, opts = {}) {
  svg.textContent = "";
  const live = series.filter((s) => s.pts && s.pts.length);
  const W = svg.clientWidth || svg.parentNode.clientWidth || 800;
  const H = opts.height || 260;
  const M = { t: 12, r: 16, b: 30, l: 58 };

  if (!live.length) {
    svg.setAttribute("viewBox", `0 0 ${W} 120`);
    svg.setAttribute("height", 120);
    const t = el("text", { x: W / 2, y: 60, "text-anchor": "middle" });
    t.textContent = opts.emptyMsg || "No data for this selection";
    svg.appendChild(t);
    return null;
  }

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", H);

  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
  for (const s of live) {
    for (const p of s.pts) {
      if (p[0] < t0) t0 = p[0];
      if (p[0] > t1) t1 = p[0];
      if (p[1] < lo) lo = p[1];
      if (p[1] > hi) hi = p[1];
    }
  }
  if (opts.domain) { t0 = opts.domain[0]; t1 = opts.domain[1]; }

  // Outlier-resistant y-domain, so one bad sensor reading can't flatten the panel.
  const rd = robustDomain(live);
  let clipped = 0;
  if (rd && rd.clipped) { lo = rd.lo; hi = rd.hi; clipped = rd.clipped; }

  for (const th of opts.thresholds || []) {
    if (th.value != null) { lo = Math.min(lo, th.value); hi = Math.max(hi, th.value); }
  }
  const pad = (hi - lo) * 0.08 || Math.abs(hi * 0.1) || 1;
  lo -= pad; hi += pad;

  const X = (t) => M.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const Y = (v) => M.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  // grid + y axis
  for (const v of niceTicks(lo, hi)) {
    const y = Y(v);
    if (y < M.t - 1 || y > M.t + ih + 1) continue;
    svg.appendChild(el("line", { class: "grid-line", x1: M.l, x2: M.l + iw, y1: y, y2: y }));
    const tx = el("text", { x: M.l - 8, y: y + 3.5, "text-anchor": "end" });
    tx.textContent = fmtN(v);
    svg.appendChild(tx);
  }
  // x axis
  svg.appendChild(el("line", { class: "axis-line", x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));
  for (const t of timeTicks(t0, t1)) {
    const tx = el("text", { x: X(t), y: M.t + ih + 17, "text-anchor": "middle" });
    tx.textContent = fmtD(t);
    svg.appendChild(tx);
  }
  if (opts.yTitle) {
    const yt = el("text", { class: "axis-title", x: -(M.t + ih / 2), y: 13, transform: "rotate(-90)", "text-anchor": "middle" });
    yt.textContent = opts.yTitle;
    svg.appendChild(yt);
  }

  // warning / danger reference lines
  for (const th of opts.thresholds || []) {
    if (th.value == null) continue;
    const y = Y(th.value);
    svg.appendChild(el("line", { class: "thresh", x1: M.l, x2: M.l + iw, y1: y, y2: y, stroke: th.color }));
    const lb = el("text", { x: M.l + iw - 3, y: y - 5, "text-anchor": "end", fill: th.color });
    lb.textContent = th.label;
    svg.appendChild(lb);
  }

  // Off-scale points must not paint over the axes and labels.
  const cid = "clip-" + Math.random().toString(36).slice(2, 9);
  const defs = el("defs");
  const cp = el("clipPath", { id: cid });
  cp.appendChild(el("rect", { x: M.l, y: M.t - 2, width: iw, height: ih + 4 }));
  defs.appendChild(cp);
  svg.appendChild(defs);
  const plot = el("g", { "clip-path": `url(#${cid})` });
  svg.appendChild(plot);

  // Build a gapped path from ordered points; a jump > brk starts a new subpath.
  const pathFrom = (pts, brk) => {
    let d = "", pen = false;
    for (let i = 0; i < pts.length; i++) {
      const gap = i > 0 && pts[i][0] - pts[i - 1][0] > brk;
      if (!pen || gap) { d += `M${X(pts[i][0]).toFixed(1)},${Y(pts[i][1]).toFixed(1)}`; pen = true; }
      else d += `L${X(pts[i][0]).toFixed(1)},${Y(pts[i][1]).toFixed(1)}`;
    }
    return d;
  };
  const medGap = (pts) => {
    const g = [];
    for (let i = 1; i < pts.length; i++) g.push(pts[i][0] - pts[i - 1][0]);
    g.sort((a, b) => a - b);
    return Math.max((g[Math.floor(g.length / 2)] || 3600000) * 4, 7200000);
  };

  const isSmoothed = state.smoothAlgo !== "none";

  for (const s of live) {
    // Imputed fills first, so the observed line sits on top of them.
    if (s.imp && s.imp.length) {
      const impPts = decimate(s.imp, iw);
      plot.appendChild(el("path", {
        class: "line imputed", d: pathFrom(impPts, medGap(impPts)), stroke: "var(--critical)",
      }));
      for (const p of impPts) {
        plot.appendChild(el("circle", { cx: X(p[0]).toFixed(1), cy: Y(p[1]).toFixed(1), r: 2, class: "dot imputed" }));
      }
    }

    // Smooth the FULL-resolution observed signal, THEN decimate for display.
    // (Decimating first would smooth the min/max envelope, not the data.)
    const smoothed = isSmoothed ? applySmoothing(s.pts, state.smoothAlgo, state.smoothSpan) : s.pts;
    const pts = decimate(smoothed, iw);
    const brk = medGap(pts);

    if (isSmoothed) {
      const rawPts = decimate(s.pts, iw);
      plot.appendChild(el("path", {
        class: "line raw-line", d: pathFrom(rawPts, medGap(rawPts)),
        stroke: s.color, opacity: 0.3, "stroke-width": 1.2,
      }));
    }

    plot.appendChild(el("path", {
      class: "line", d: pathFrom(pts, brk), stroke: s.color, "stroke-width": isSmoothed ? 2.5 : 2,
    }));
  }

  attachHover(svg, live, { X, Y, M, iw, ih, t0, t1 }, opts);
  return { X, Y, t0, t1, lo, hi, clipped, total: rd ? rd.total : 0 };
}

/* ---------------- crosshair + tooltip ---------------- */

const tip = $("#tip");

function attachHover(svg, series, geo, opts) {
  const { X, M, iw, ih, t0, t1 } = geo;
  const cross = el("line", { class: "grid-line", y1: M.t, y2: M.t + ih, stroke: "var(--border-strong)", opacity: 0 });
  svg.appendChild(cross);
  const dots = series.map((s) => {
    const c = el("circle", { r: 4.5, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 });
    svg.appendChild(c);
    return c;
  });

  const hit = el("rect", { x: M.l, y: M.t, width: iw, height: ih, fill: "transparent", style: "cursor:crosshair" });
  svg.appendChild(hit);

  const hide = () => {
    tip.style.opacity = 0;
    cross.setAttribute("opacity", 0);
    dots.forEach((d) => d.setAttribute("opacity", 0));
  };

  hit.addEventListener("mouseleave", hide);
  hit.addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * (svg.viewBox.baseVal.width || box.width);
    const t = t0 + ((sx - M.l) / iw) * (t1 - t0);

    cross.setAttribute("x1", sx); cross.setAttribute("x2", sx); cross.setAttribute("opacity", 0.75);

    let html = "", any = false, when = t;
    series.forEach((s, i) => {
      // nearest sample by time
      let best = null, bd = Infinity;
      for (const p of s.pts) {
        const d = Math.abs(p[0] - t);
        if (d < bd) { bd = d; best = p; }
      }
      if (!best || bd > (t1 - t0) / 40) { dots[i].setAttribute("opacity", 0); return; }
      any = true; when = best[0];
      dots[i].setAttribute("cx", X(best[0]));
      dots[i].setAttribute("cy", geo.Y(best[1]));
      dots[i].setAttribute("opacity", 1);
      html += `<div class="row"><span class="l"><span class="sw" style="background:${s.color}"></span>${s.label}</span><span class="v">${fmtN(best[1])}${s.unit ? " " + s.unit : ""}</span></div>`;
    });

    if (!any) { hide(); return; }
    tip.innerHTML = `<div class="t">${fmtDT(when)}</div>${html}`;
    tip.style.opacity = 1;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let lx = ev.clientX + 14, ly = ev.clientY - th / 2;
    if (lx + tw > innerWidth - 8) lx = ev.clientX - tw - 14;
    tip.style.left = Math.max(8, lx) + "px";
    tip.style.top = Math.min(Math.max(8, ly), innerHeight - th - 8) + "px";
  });
}

function legend(node, items) {
  node.innerHTML = items.map((i) =>
    `<span class="item"><span class="swatch" style="background:${i.color}"></span>${i.label}${i.unit ? ` <span style="color:var(--text-muted)">(${i.unit})</span>` : ""}</span>`
  ).join("");
}

/* ---------------- render ---------------- */

function unit(p) { return (state.index.units || {})[p] || ""; }

const LABELS = {
  pCO2_uatm: "pCO₂", Delta_pCO2: "ΔpCO₂", FCO2_mmol_m2_d: "CO₂ flux",
  k600: "k₆₀₀", Alkalinity_mgL: "Alkalinity", WSE: "Water surface elev.",
};
const label = (p) => LABELS[p] || p;

function getFilteredStations() {
  return state.index.stations.filter((s) => {
    const matchesState = !state.selectedState || s.state === state.selectedState;
    const matchesStretch = !state.stretch || s.stretch === state.stretch;
    return matchesState && matchesStretch;
  });
}

function updateStationSelectOptions() {
  const filtered = getFilteredStations();
  const select = $("#station-select");
  if (!select) return;
  select.innerHTML = filtered
    .map((s) => `<option value="${s.station_id}"${String(s.station_id) === String(state.stationId) ? " selected" : ""}>${s.station_name}</option>`)
    .join("");
  if (state.stationId) {
    select.value = String(state.stationId);
  }
}

function renderStationMetaCard() {
  const card = $("#station-meta-card");
  if (!card) return;
  const s = state.index.stations.find((st) => st.station_id === state.stationId);
  if (!s) {
    card.innerHTML = "";
    return;
  }
  
  const l = s.latest[state.param];
  const lastVal = l ? `${fmtN(l.last)} ${unit(state.param)}` : "—";
  const dateStr = l ? fmtDT(l.at) : "—";

  card.innerHTML = `
    <h3>Selected Station Details</h3>
    <div class="meta-item">
      <span class="meta-label">Code</span>
      <span class="meta-val">${s.station_code || "—"}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">State</span>
      <span class="meta-val">${s.state || "—"}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Stretch</span>
      <span class="meta-val">${s.stretch || "—"}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Coordinates</span>
      <span class="meta-val">${s.lat ? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}` : "—"}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Latest ${state.param}</span>
      <span class="meta-val">${lastVal}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Observed At</span>
      <span class="meta-val">${dateStr}</span>
    </div>
  `;
}

function renderStationList() {
  const rows = getFilteredStations();

  const vals = rows.map((s) => s.latest[state.param]?.last).filter((v) => v != null);
  const sorted = [...vals].sort((a, b) => a - b);
  const lo = sorted.length ? sorted[0] : 0;
  const hi = sorted.length ? sorted[sorted.length - 1] : 0;
  const ramp = ["var(--seq-100)", "var(--seq-250)", "var(--seq-400)", "var(--seq-550)", "var(--seq-700)"];
  const brk = sorted.length ? [0.2, 0.4, 0.6, 0.8].map((f) => sorted[Math.floor(sorted.length * f)] ?? hi) : [];
  const color = (v) => {
    if (v == null) return "var(--border)";
    let i = 0;
    while (i < brk.length && v >= brk[i]) i++;
    return ramp[i];
  };

  $("#aside-head").textContent = `Location Selection`;
  renderStationMetaCard();
  return { lo, hi, color, rows };
}

function renderTiles() {
  const st = state.station;
  const idx = state.index.stations.find((s) => s.station_id === state.stationId);
  const wanted = [state.param, "DO", "BOD", "pH", "WSE", "FCO2_mmol_m2_d"];
  const seen = new Set();
  const tiles = [];
  for (const p of wanted) {
    if (seen.has(p)) continue;
    seen.add(p);
    const l = idx?.latest[p];
    if (!l) continue;
    tiles.push(`<div class="tile">
      <div class="k">${label(p)}</div>
      <div class="v">${fmtN(l.last)}<span class="u">${unit(p)}</span></div>
      <div class="s">mean ${fmtN(l.mean)} · n=${l.n.toLocaleString()}</div>
    </div>`);
  }
  $("#tiles").innerHTML = tiles.join("");
}

function renderCharts() {
  const st = state.station;
  const wq = st.blocks.wq, wse = st.blocks.wse, flux = st.blocks.flux;

  // main parameter panel — observed line, imputed fills overlaid only if opted in
  const pts = windowed(unpack(wq, state.param));
  const imp = unpackImputed("wq", state.param);
  $("#ts-title").textContent = `${state.param} — ${st.station_name}`;
  $("#ts-sub").textContent = pts
    ? `${pts.length.toLocaleString()} observed readings · ${fmtD(pts[0][0])} to ${fmtD(pts[pts.length - 1][0])}`
    : "no observed readings in this window";
  if (imp && imp.length) $("#ts-sub").textContent += ` · +${imp.length.toLocaleString()} imputed (red)`;
  const mainSeries = [{ label: state.param, unit: unit(state.param), color: SERIES(0), pts, imp }];
  legend($("#ts-legend"), mainSeries);
  const geo = drawChart($("#ts-chart"), mainSeries, { yTitle: unit(state.param), height: 280 });
  if (geo && geo.clipped) $("#ts-sub").textContent += ` · ${geo.clipped} outlier(s) off-scale`;

  // shared time domain so the panels line up visually
  const domain = geo ? [geo.t0, geo.t1] : null;

  // WSE on its own panel — never a second y-axis on the panel above
  const wsePts = windowed(unpack(wse, "WSE"));
  $("#wse-card").style.display = wsePts ? "" : "none";
  if (wsePts) {
    const s = [{ label: "WSE", unit: "m", color: SERIES(4), pts: wsePts, imp: unpackImputed("wse", "WSE") }];
    legend($("#wse-legend"), s);
    const g = drawChart($("#wse-chart"), s, {
      yTitle: "m", height: 200, domain,
      thresholds: [
        { value: st.levels?.warning, label: "warning", color: "var(--warning)" },
        { value: st.levels?.danger, label: "danger", color: "var(--critical)" },
      ],
    });
    $("#wse-card").querySelector(".sub").textContent =
      `CWC flood-forecast gauge, hourly, on its own axis and aligned in time with the panel above · ` +
      `${wsePts.length.toLocaleString()} points` +
      (g && g.clipped ? ` · ${g.clipped} outlier(s) off-scale` : "");
  }

  // derived flux
  const fp = state.index.flux_params || [];
  const fseries = [];
  if (flux) {
    ["pCO2_uatm", "FCO2_mmol_m2_d"].forEach((p, i) => {
      const q = windowed(unpack(flux, p));
      if (q) fseries.push({ label: label(p), unit: unit(p), color: SERIES(i === 0 ? 6 : 5), pts: q, imp: unpackImputed("flux", p) });
    });
  }
  $("#flux-card").style.display = fseries.length ? "" : "none";
  if (fseries.length) {
    // different magnitudes -> one panel each, per the no-dual-axis rule
    legend($("#flux-legend"), [fseries[0]]);
    const g = drawChart($("#flux-chart"), [fseries[0]], { yTitle: fseries[0].unit, height: 200, domain });
    $("#flux-sub").textContent =
      `Computed pCO₂ from the co2sys analysis · ${fseries[0].pts.length.toLocaleString()} points` +
      (g && g.clipped ? ` · ${g.clipped} outlier(s) off-scale` : "");
  }
}

function renderMap() {
  const { lo, hi, color, rows } = renderStationList();
  const pts = rows.filter((s) => s.lat && s.lon);
  if (!pts.length) return;

  // Google Satellite/Hybrid map layer
  const tileUrl = "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}";
  const tileAttrib = 'Map data &copy;2026 Google';

  $("#map-sub").textContent = `${pts.length} stations, coloured by latest ${state.param}`;
  $("#scale-lo").textContent = fmtN(lo);
  $("#scale-hi").textContent = fmtN(hi);
  $("#scale-bar").style.background =
    "linear-gradient(90deg,var(--seq-100),var(--seq-250),var(--seq-400),var(--seq-550),var(--seq-700))";

  if (!mapObj) {
    mapObj = L.map("map", {
      center: [26.0, 83.0],
      zoom: 6,
      minZoom: 4,
      maxZoom: 13
    });
    
    mapObj.baseLayer = L.tileLayer(tileUrl, {
      attribution: tileAttrib
    }).addTo(mapObj);
    
    markersLayer = L.layerGroup().addTo(mapObj);
    
    fetch(`${WORKER_URL}/data/ganga_basin.geojson`)
      .then(res => res.json())
      .then(geoJsonData => {
        geoJsonLayer = L.geoJSON(geoJsonData, {
          style: {
            color: "#00d0ff", // bright cyan for satellite contrast
            weight: 2,
            opacity: 0.85,
            fillColor: "#00d0ff",
            fillOpacity: 0.05
          }
        }).addTo(mapObj);
      })
      .catch(err => console.error("Error loading Ganga Basin shapefile:", err));
  } else {
    if (mapObj.baseLayer) {
      mapObj.baseLayer.setUrl(tileUrl);
    }
  }

  if (markersLayer) {
    markersLayer.clearLayers();
  }

  for (const s of pts) {
    const v = s.latest[state.param]?.last;
    const isSelected = s.station_id === state.stationId;
    
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: isSelected ? 9.5 : 6.5,
      fillColor: color(v),
      fillOpacity: 0.9,
      color: isSelected ? "#e34948" : "#ffffff", // bright red outline for selected, clean white for others
      weight: isSelected ? 3.5 : 2,
    });
    
    const tooltipContent = `
      <div style="font-family: inherit; font-size: 12px; line-height: 1.4;">
        <strong style="display:block; margin-bottom: 4px; color: var(--text-primary);">${s.station_name}</strong>
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <span style="color:var(--text-muted);">${state.param}:</span>
          <strong style="font-family:var(--mono);">${v != null ? fmtN(v) + " " + unit(state.param) : "—"}</strong>
        </div>
        <div style="display:flex; justify-content:space-between; gap:10px;">
          <span style="color:var(--text-muted);">Stretch:</span>
          <span>${s.stretch || "—"}</span>
        </div>
      </div>
    `;
    
    marker.bindTooltip(tooltipContent, {
      direction: "top",
      offset: [0, -5],
      className: "custom-map-tooltip"
    });
    
    marker.on("click", () => {
      selectStation(s.station_id);
    });
    
    if (markersLayer) {
      markersLayer.addLayer(marker);
    }
  }

  // Recalculate bounds from current filtered points & center the Google Earth map perfectly
  const lats = pts.map(s => s.lat);
  const lons = pts.map(s => s.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const bounds = L.latLngBounds([minLat, minLon], [maxLat, maxLon]);

  mapObj.invalidateSize();
  mapObj.fitBounds(bounds, { padding: [35, 35], maxZoom: 9 });
}

function renderTable() {
  const wq = state.station.blocks.wq;
  if (!wq) { $("#table").innerHTML = '<p class="empty">No tabular data</p>'; return; }
  const params = Object.keys(wq.v);
  const t0 = new Date(wq.t0 + ":00").getTime();
  const rows = [];
  for (let i = wq.t.length - 1; i >= 0 && rows.length < 500; i--) {
    rows.push(`<tr><td>${fmtDT(t0 + wq.t[i] * 60000)}</td>` +
      params.map((p) => `<td>${wq.v[p][i] == null ? "" : fmtN(wq.v[p][i])}</td>`).join("") + "</tr>");
  }
  $("#table").innerHTML = `<table><thead><tr><th>Timestamp</th>${params.map((p) => `<th>${p}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/* ---------------- control ---------------- */

// Fetch the imputed sidecar for the current station (cached). Missing file → null.
async function ensureImputed() {
  const id = state.stationId;
  if (!impCache.has(id)) {
    try {
      const data = await secureFetch(`/data/stations/${id}.imp.json`);
      impCache.set(id, data || null);
    } catch { impCache.set(id, null); }
  }
  state.imputed = impCache.get(id);
}

async function selectStation(id) {
  state.stationId = Number(id);
  state.station = await secureFetch(`/data/stations/${id}.json`);
  state.imputed = null;
  if (state.showImputed) await ensureImputed();

  const idx = state.index.stations.find((s) => String(s.station_id) === String(id));
  if (idx) {
    const filtered = getFilteredStations();
    const inCurrentFilter = filtered.some(s => String(s.station_id) === String(id));
    if (!inCurrentFilter) {
      state.selectedState = idx.state || "";
      if ($("#state-select")) $("#state-select").value = state.selectedState;
      updateStationSelectOptions();
    }
    if ($("#station-select")) $("#station-select").value = String(id);
  }
  
  renderAll();
}

function renderAll() {
  renderStationList();
  if (state.station) { renderTiles(); renderCharts(); renderTable(); }
  renderMap();
}

async function performLogin(username, password) {
  const btn = document.getElementById("login-btn");
  const errEl = document.getElementById("login-error");
  if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }
  if (errEl) errEl.textContent = "";

  try {
    const res = await fetch(`${WORKER_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (errEl) errEl.textContent = d.error || "Invalid username or password.";
      if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }
      return false;
    }

    const { token } = await res.json();
    sessionStorage.setItem("grbms_token", token);
    hideLoginScreen();

    // Clean URL bar if query params like ?username=...&password=... were passed
    if (window.location.search) {
      history.replaceState(null, "", window.location.pathname);
    }
    return true;
  } catch (err) {
    if (errEl) errEl.textContent = "Cannot reach server. Check connection.";
    if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }
    return false;
  }
}

async function init() {
  // ── AUTH: check existing token, URL params, or form submit ──────────────
  const existingToken = sessionStorage.getItem("grbms_token");
  if (existingToken) {
    hideLoginScreen();
  } else {
    // Check if query params were passed in URL (e.g. ?username=ankit&password=REDACTED)
    const params = new URLSearchParams(window.location.search);
    const uParam = params.get("username");
    const pParam = params.get("password");

    let authed = false;
    if (uParam && pParam) {
      showLoginScreen();
      authed = await performLogin(uParam, pParam);
    }

    if (!authed) {
      showLoginScreen();
      await new Promise((resolve) => {
        const form = document.getElementById("login-form");
        if (!form) return resolve();
        form.onsubmit = async (e) => {
          e.preventDefault();
          const u = document.getElementById("login-user").value;
          const p = document.getElementById("login-pass").value;
          const ok = await performLogin(u, p);
          if (ok) resolve();
        };
      });
    }
  }

  // ── DATA: load index via Worker ─────────────────────────────────────────
  state.index = await secureFetch("/data/index.json");
  const ix = state.index;

  $("#hdr-meta").textContent =
    `${ix.stations.length} stations · ${ix.range[0]} to ${ix.range[1]} · ${ix.n_obs.toLocaleString()} observations · built ${ix.generated}`;

  state.param = ix.params.includes("DO") ? "DO" : ix.params[0];
  $("#param").innerHTML = ix.params
    .map((p) => `<option value="${p}"${p === state.param ? " selected" : ""}>${p}${unit(p) ? " (" + unit(p) + ")" : ""}</option>`)
    .join("");
  $("#param").onchange = (e) => { state.param = e.target.value; renderAll(); };
  
  if ($("#show-imputed")) {
    $("#show-imputed").checked = state.showImputed;
    $("#show-imputed").onchange = async (e) => {
      state.showImputed = e.target.checked;
      if (state.showImputed) await ensureImputed(); // lazy-load only when asked
      renderCharts();
    };
  }
  if ($("#smooth-algo")) {
    $("#smooth-algo").value = state.smoothAlgo;
    $("#smooth-algo").onchange = (e) => { state.smoothAlgo = e.target.value; renderAll(); };
  }
  if ($("#smooth-span")) {
    $("#smooth-span").value = state.smoothSpan;
    $("#smooth-span").onchange = (e) => { state.smoothSpan = Number(e.target.value); renderAll(); };
  }

  const stretches = [...new Set(ix.stations.map((s) => s.stretch).filter(Boolean))];
  $("#stretch").innerHTML = '<option value="">All stretches</option>' +
    stretches.map((s) => `<option value="${s}">${s}</option>`).join("");
  $("#stretch").onchange = (e) => {
    state.stretch = e.target.value;
    updateStationSelectOptions();
    const filtered = getFilteredStations();
    if (filtered.length > 0) {
      const currentStillValid = filtered.some(s => String(s.station_id) === String(state.stationId));
      if (!currentStillValid) {
        selectStation(filtered[0].station_id);
      } else {
        renderAll();
      }
    } else {
      renderAll();
    }
  };

  const states = [...new Set(ix.stations.map((s) => s.state).filter(Boolean))].sort();
  $("#state-select").innerHTML = '<option value="">All States</option>' +
    states.map((st) => `<option value="${st}">${st}</option>`).join("");
  $("#state-select").onchange = (e) => {
    state.selectedState = e.target.value;
    updateStationSelectOptions();
    const filtered = getFilteredStations();
    if (filtered.length > 0) {
      const currentStillValid = filtered.some(s => String(s.station_id) === String(state.stationId));
      if (!currentStillValid) {
        selectStation(filtered[0].station_id);
      } else {
        renderAll();
      }
    } else {
      renderAll();
    }
  };

  $("#station-select").onchange = (e) => {
    if (e.target.value) {
      selectStation(e.target.value);
    }
  };

  $("#ranges").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      state.days = +b.dataset.days;
      $("#ranges").querySelectorAll("button").forEach((o) => o.setAttribute("aria-pressed", o === b));
      if (state.station) { renderCharts(); }
    };
  });

  const btn = $("#theme-btn");
  const apply = (dark) => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    btn.textContent = dark ? "Light" : "Dark";
    localStorage.setItem("ganga-theme", dark ? "dark" : "light");
    if (state.station) requestAnimationFrame(renderAll);
  };
  const saved = localStorage.getItem("ganga-theme");
  apply(saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  btn.onclick = () => apply(document.documentElement.getAttribute("data-theme") !== "dark");

  let rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      renderAll();
      if (mapObj) {
        mapObj.invalidateSize();
      }
    }, 160);
  });

  updateStationSelectOptions();
  await selectStation(ix.stations[0].station_id);
}

init().catch((e) => {
  document.querySelector("main").innerHTML =
    `<div class="card"><h2>Failed to load</h2><p class="sub">${e}</p>
     <p class="sub">If you opened this file directly, run a local server instead:<br>
     <code>cd site &amp;&amp; python3 -m http.server 8000</code></p></div>`;
});
