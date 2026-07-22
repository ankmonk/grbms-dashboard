/* WRIS Hydro-Meteorological Explorer
   Static: fetches prebuilt monthly payloads, renders SVG by hand. No deps but Leaflet. */

const $ = (s) => document.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const el = (tag, a = {}) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };

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
  setTimeout(() => { if (mapObj) mapObj.invalidateSize(); }, 120);
}

const state = {
  index: null,
  variable: null,   // {name, slug, unit, agg, ...}
  data: null,       // loaded variable payload {stations:[…]}
  station: null,    // selected station object
  selState: "",
  search: "",
};
const cache = new Map(); // slug -> payload
let mapObj = null, markersLayer = null;

/* ---------- time / format ---------- */

// t0 "YYYY-MM" + month offset -> ms timestamp (mid-month, for plotting)
function ymToDate(t0, off) {
  const y = +t0.slice(0, 4), m = +t0.slice(5, 7);
  const total = (y * 12 + (m - 1)) + off;
  return new Date(Math.floor(total / 12), total % 12, 15).getTime();
}

function seriesPts(st, key = "v") {
  const out = [];
  for (let i = 0; i < st.t.length; i++) {
    const val = st[key][i];
    if (val === null || val === undefined) continue;
    out.push([ymToDate(st.t0, st.t[i]), val]);
  }
  return out;
}

const fmtN = (v) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 10000) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
};
const fmtMonth = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });

/* ---------- scales ---------- */

function niceTicks(lo, hi, n = 5) {
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
  return out;
}
function robust(vals) {
  const a = [...vals].sort((x, y) => x - y);
  const q = (f) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * f)))];
  let lo = q(0.01), hi = q(0.99);
  if (lo === hi) { lo = a[0]; hi = a[a.length - 1]; }
  return { lo, hi, clipped: a.filter((v) => v < lo || v > hi).length };
}

/* ---------- chart: mean line + min/max band (or plain line for sums) ---------- */

const tip = $("#tip");

function drawChart(svg, st) {
  svg.textContent = "";
  const mean = seriesPts(st, "v");
  if (!mean.length) {
    svg.setAttribute("viewBox", "0 0 800 120"); svg.setAttribute("height", 120);
    const t = el("text", { x: 400, y: 60, "text-anchor": "middle", fill: "var(--text-muted)" });
    t.textContent = "No data for this station"; svg.appendChild(t); return;
  }
  const showBand = state.variable.agg === "mean";
  const lo = showBand ? seriesPts(st, "min") : [];
  const hi = showBand ? seriesPts(st, "max") : [];

  const W = svg.clientWidth || svg.parentNode.clientWidth || 820, H = 300;
  const M = { t: 12, r: 16, b: 30, l: 60 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H);
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  let t0 = Infinity, t1 = -Infinity;
  for (const p of mean) { if (p[0] < t0) t0 = p[0]; if (p[0] > t1) t1 = p[0]; }

  // y-domain from the band if present, else the line; robust to outliers
  const pool = showBand ? hi.map((p) => p[1]).concat(lo.map((p) => p[1])) : mean.map((p) => p[1]);
  const rd = robust(pool);
  let ylo = rd.lo, yhi = rd.hi;
  const pad = (yhi - ylo) * 0.08 || Math.abs(yhi * 0.1) || 1;
  ylo -= pad; yhi += pad;

  const X = (t) => M.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const Y = (v) => M.t + ih - ((v - ylo) / (yhi - ylo || 1)) * ih;

  for (const v of niceTicks(ylo, yhi)) {
    const y = Y(v); if (y < M.t - 1 || y > M.t + ih + 1) continue;
    svg.appendChild(el("line", { class: "grid-line", x1: M.l, x2: M.l + iw, y1: y, y2: y }));
    const tx = el("text", { x: M.l - 8, y: y + 3.5, "text-anchor": "end" }); tx.textContent = fmtN(v); svg.appendChild(tx);
  }
  svg.appendChild(el("line", { class: "axis-line", x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih }));
  for (let i = 0; i <= 6; i++) { const t = t0 + ((t1 - t0) * i) / 6; const tx = el("text", { x: X(t), y: M.t + ih + 17, "text-anchor": "middle" }); tx.textContent = fmtMonth(t); svg.appendChild(tx); }
  const yt = el("text", { class: "axis-title", x: -(M.t + ih / 2), y: 13, transform: "rotate(-90)", "text-anchor": "middle" });
  yt.textContent = state.variable.unit || ""; svg.appendChild(yt);

  const cid = "clip-" + Math.random().toString(36).slice(2, 8);
  const defs = el("defs"); const cp = el("clipPath", { id: cid });
  cp.appendChild(el("rect", { x: M.l, y: M.t - 2, width: iw, height: ih + 4 })); defs.appendChild(cp); svg.appendChild(defs);
  const plot = el("g", { "clip-path": `url(#${cid})` }); svg.appendChild(plot);

  // min/max band as a filled area between hi and reversed lo
  if (showBand && lo.length && hi.length) {
    let d = "M";
    hi.forEach((p, i) => { d += `${i ? "L" : ""}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)} `; });
    for (let i = lo.length - 1; i >= 0; i--) d += `L${X(lo[i][0]).toFixed(1)},${Y(lo[i][1]).toFixed(1)} `;
    d += "Z";
    plot.appendChild(el("path", { d, fill: "var(--series-1)", opacity: 0.13 }));
  }

  const line = (pts) => { let d = "", pen = false; for (const p of pts) { d += `${pen ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`; pen = true; } return d; };
  plot.appendChild(el("path", { class: "line", d: line(mean), stroke: "var(--series-1)", "stroke-width": 2, fill: "none" }));

  attachHover(svg, st, { X, Y, M, iw, ih, t0, t1, mean });
  if (rd.clipped) $("#ts-sub").textContent += ` · ${rd.clipped} month(s) off-scale`;
}

function attachHover(svg, st, g) {
  const { X, Y, M, iw, ih, t0, t1, mean } = g;
  const cross = el("line", { class: "grid-line", y1: M.t, y2: M.t + ih, stroke: "var(--border-strong)", opacity: 0 }); svg.appendChild(cross);
  const dot = el("circle", { r: 4.5, fill: "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 }); svg.appendChild(dot);
  const hit = el("rect", { x: M.l, y: M.t, width: iw, height: ih, fill: "transparent", style: "cursor:crosshair" }); svg.appendChild(hit);
  const hide = () => { tip.style.opacity = 0; cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); };
  hit.addEventListener("mouseleave", hide);
  hit.addEventListener("mousemove", (ev) => {
    const box = svg.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * (svg.viewBox.baseVal.width || box.width);
    const t = t0 + ((sx - M.l) / iw) * (t1 - t0);
    let best = null, bd = Infinity, bi = 0;
    mean.forEach((p, i) => { const d = Math.abs(p[0] - t); if (d < bd) { bd = d; best = p; bi = i; } });
    if (!best) { hide(); return; }
    cross.setAttribute("x1", X(best[0])); cross.setAttribute("x2", X(best[0])); cross.setAttribute("opacity", 0.75);
    dot.setAttribute("cx", X(best[0])); dot.setAttribute("cy", Y(best[1])); dot.setAttribute("opacity", 1);
    const idx = st.t.findIndex((o) => ymToDate(st.t0, o) === best[0]);
    const n = idx >= 0 ? st.n[idx] : "";
    const u = state.variable.unit;
    let rows = `<div class="row"><span class="l"><span class="sw" style="background:var(--series-1)"></span>${state.variable.agg === "sum" ? "total" : "mean"}</span><span class="v">${fmtN(best[1])} ${u}</span></div>`;
    if (state.variable.agg === "mean" && idx >= 0) rows += `<div class="row"><span class="l">range</span><span class="v">${fmtN(st.min[idx])}–${fmtN(st.max[idx])}</span></div>`;
    rows += `<div class="row"><span class="l">readings</span><span class="v">${n}</span></div>`;
    tip.innerHTML = `<div class="t">${fmtMonth(best[0])}</div>${rows}`;
    tip.style.opacity = 1;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let lx = ev.clientX + 14; if (lx + tw > innerWidth - 8) lx = ev.clientX - tw - 14;
    tip.style.left = Math.max(8, lx) + "px";
    tip.style.top = Math.min(Math.max(8, ev.clientY - th / 2), innerHeight - th - 8) + "px";
  });
}

/* ---------- station stats ---------- */

function statOf(st) {
  const v = st.v.filter((x) => x != null);
  if (!v.length) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  return { last: v[v.length - 1], mean: sum / v.length, min: Math.min(...v), max: Math.max(...v), months: v.length,
           reads: st.n.reduce((a, b) => a + b, 0) };
}

/* ---------- filtering ---------- */

function filtered() {
  const q = state.search.trim().toLowerCase();
  return state.data.stations.filter((s) => {
    if (state.selState && s.state !== state.selState) return false;
    if (q && !((s.name || "").toLowerCase().includes(q) || (s.district || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

/* ---------- renderers ---------- */

function ramp(vals) {
  const sorted = [...vals].sort((a, b) => a - b);
  const R = ["var(--seq-100)", "var(--seq-250)", "var(--seq-400)", "var(--seq-550)", "var(--seq-700)"];
  const brk = sorted.length ? [0.2, 0.4, 0.6, 0.8].map((f) => sorted[Math.floor(sorted.length * f)]) : [];
  return {
    lo: sorted[0], hi: sorted[sorted.length - 1],
    color: (v) => { if (v == null) return "var(--border)"; let i = 0; while (i < brk.length && v >= brk[i]) i++; return R[i]; },
  };
}

function renderPillsBar() {
  const bar = $("#wris-pills-bar");
  if (!bar || !state.index) return;
  const icons = {
    ground_water_level: "🌊",
    rainfall: "🌧️",
    river_water_discharge: "💧",
    river_water_level: "📏",
    suspended_sediment: "🧪",
    temperature: "🌡️",
    relative_humidity: "💧",
    wind_direction: "💨",
    atmospheric_pressure: "⏱️"
  };
  bar.innerHTML = state.index.variables.map(v => {
    const isActive = state.variable && state.variable.slug === v.slug;
    const icon = icons[v.slug] || "📊";
    return `<div class="wris-pill${isActive ? " active" : ""}" onclick="loadVariable('${v.slug}')">
      <span>${icon}</span>
      <span>${v.name}</span>
      <span class="wris-pill-count">${v.n_stations}</span>
    </div>`;
  }).join("");
}

function renderList() {
  const list = $("#station-list");
  const rows = filtered();
  $("#list-head").textContent = `${rows.length} station${rows.length === 1 ? "" : "s"}`;
  const stat = (s) => statOf(s);
  const vals = rows.map((s) => stat(s)?.last).filter((v) => v != null);
  const { color } = ramp(vals);
  list.innerHTML = "";
  for (const s of rows.slice(0, 400)) {
    const st = stat(s);
    const isSelected = state.station && s.code === state.station.code;
    const d = document.createElement("div");
    d.className = `station-item${isSelected ? " active" : ""}`;
    d.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="width:8px; height:8px; border-radius:50%; background:${color(st?.last)}; display:inline-block;"></span>
        <div>
          <div class="station-item-name">${s.name}</div>
          <div style="font-size:11px; color:var(--text-muted);">${s.district || ""}${s.state ? " · " + s.state : ""}</div>
        </div>
      </div>
      <div class="station-item-val">${st ? fmtN(st.last) : "—"}</div>
    `;
    d.onclick = () => selectStation(s.code);
    list.appendChild(d);
  }
  if (rows.length > 400) {
    const more = document.createElement("div");
    more.style.padding = "8px 12px";
    more.style.fontSize = "11px";
    more.style.color = "var(--text-muted)";
    more.textContent = `+${rows.length - 400} more — use search to filter`;
    list.appendChild(more);
  }
  return { rows, color };
}

function renderTiles() {
  const s = statOf(state.station);
  const u = state.variable.unit;
  if (!s) { $("#tiles").innerHTML = ""; return; }
  const tiles = [
    ["Latest Value", fmtN(s.last), u],
    [state.variable.agg === "sum" ? "Mean Monthly Total" : "Mean Value", fmtN(s.mean), u],
    ["Minimum", fmtN(s.min), u],
    ["Maximum", fmtN(s.max), u],
    ["Recorded Months", s.months.toLocaleString(), ""],
    ["Total Readings", s.reads.toLocaleString(), ""],
  ];
  $("#tiles").innerHTML = tiles.map(([k, v, un]) => `
    <div class="tile">
      <div class="tile-label">${k}</div>
      <div class="tile-val">${v} ${un ? '<span style="font-size:12px; color:var(--text-muted);">' + un + '</span>' : ''}</div>
    </div>
  `).join("");
}

function renderChart() {
  const st = state.station;
  const pts = seriesPts(st);
  $("#ts-title").textContent = `${state.variable.name} — ${st.name}`;
  $("#ts-sub").textContent = pts.length
    ? `${st.district || ""}${st.state ? ", " + st.state : ""} · ${st.agency || ""} · ${pts.length} months (${fmtMonth(pts[0][0])} to ${fmtMonth(pts[pts.length - 1][0])})`
    : "No data available";
  const lbl = state.variable.agg === "sum" ? "Monthly Total" : "Monthly Mean";
  $("#ts-legend").innerHTML =
    `<span class="legend-item"><span class="legend-color" style="background:var(--series-1)"></span>${lbl} (${state.variable.unit})</span>` +
    (state.variable.agg === "mean" ? `<span class="legend-item" style="color:var(--text-muted)"><span class="legend-color" style="background:var(--series-1);opacity:.3"></span>Monthly Min–Max Range</span>` : "");
  drawChart($("#ts-chart"), st);
}

function renderTable() {
  const st = state.station;
  const rows = [];
  for (let i = st.t.length - 1; i >= 0 && rows.length < 400; i--) {
    const ym = ymToDate(st.t0, st.t[i]);
    rows.push(`<tr><td>${fmtMonth(ym)}</td><td>${fmtN(st.v[i])}</td><td>${fmtN(st.min[i])}</td><td>${fmtN(st.max[i])}</td><td>${st.n[i]}</td></tr>`);
  }
  const vlabel = state.variable.agg === "sum" ? "Total" : "Mean";
  $("#table").innerHTML = `<table><thead><tr><th>Month</th><th>${vlabel}</th><th>Min</th><th>Max</th><th>Readings</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderMap() {
  const { rows, color } = renderList();
  const pts = rows.filter((s) => s.lat && s.lon);
  const vals = rows.map((s) => statOf(s)?.last).filter((v) => v != null);
  const { lo, hi } = ramp(vals);

  // Google Satellite/Hybrid map layer
  const tileUrl = "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}";
  const tileAttrib = 'Map data &copy;2026 Google';

  $("#map-sub").textContent = `${pts.length} stations located in basin, coloured by latest ${state.variable.name}`;
  $("#scale-lo").textContent = fmtN(lo); $("#scale-hi").textContent = fmtN(hi);
  $("#scale-bar").style.background = "linear-gradient(90deg,var(--seq-100),var(--seq-250),var(--seq-400),var(--seq-550),var(--seq-700))";

  if (!pts.length) { if (markersLayer) markersLayer.clearLayers(); return; }

  if (!mapObj) {
    mapObj = L.map("map", { center: [26, 83], zoom: 6, minZoom: 4, maxZoom: 13 });
    mapObj.baseLayer = L.tileLayer(tileUrl, { attribution: tileAttrib }).addTo(mapObj);
    markersLayer = L.layerGroup().addTo(mapObj);

    fetch(`${WORKER_URL}/data/ganga_basin.geojson`)
      .then(res => res.json())
      .then(geoJsonData => {
        L.geoJSON(geoJsonData, {
          style: {
            color: "#00d0ff",
            weight: 2,
            opacity: 0.85,
            fillColor: "#00d0ff",
            fillOpacity: 0.05
          }
        }).addTo(mapObj);
      })
      .catch(() => {});
  } else if (mapObj.baseLayer) {
    mapObj.baseLayer.setUrl(tileUrl);
  }

  markersLayer.clearLayers();

  for (const s of pts) {
    const sel = state.station && s.code === state.station.code;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: sel ? 9.5 : 6.5,
      fillColor: color(statOf(s)?.last),
      fillOpacity: 0.9,
      color: sel ? "#e34948" : "#ffffff",
      weight: sel ? 3.5 : 2,
    });
    
    m.bindTooltip(`
      <div style="font-family:inherit; font-size:12px;">
        <strong style="display:block; margin-bottom:4px;">${s.name}</strong>
        <div>${state.variable.name}: <strong>${fmtN(statOf(s)?.last)} ${state.variable.unit}</strong></div>
        <div style="color:var(--text-muted); font-size:11px;">${s.district || ""}${s.state ? " · " + s.state : ""}</div>
      </div>
    `, { direction: "top" });

    m.on("click", () => selectStation(s.code));
    markersLayer.addLayer(m);
  }

  const lats = pts.map((s) => s.lat), lons = pts.map((s) => s.lon);
  mapObj.invalidateSize();
  mapObj.fitBounds([[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]], { padding: [35, 35], maxZoom: 9 });
}

function renderAll() {
  renderPillsBar();
  if (state.station) { renderTiles(); renderChart(); renderTable(); }
  renderMap();
}

/* ---------- control ---------- */

function selectStation(code) {
  state.station = state.data.stations.find((s) => s.code === code) || null;
  renderAll();
}

async function loadVariable(slug) {
  if (!cache.has(slug)) {
    const data = await secureFetch(`/data/wris/${slug}.json`);
    cache.set(slug, data);
  }
  state.data = cache.get(slug);
  state.variable = state.index.variables.find((v) => v.slug === slug);

  // state options scoped to this variable
  const states = [...new Set(state.data.stations.map((s) => s.state).filter(Boolean))].sort();
  $("#state-select").innerHTML = '<option value="">All states</option>' + states.map((s) => `<option value="${s}">${s}</option>`).join("");
  if (state.selState && !states.includes(state.selState)) state.selState = "";
  $("#state-select").value = state.selState;

  const rows = filtered();
  state.station = rows[0] || state.data.stations[0] || null;
  $("#map-title").textContent = `${state.variable.name} — station map`;
  renderAll();
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
    // Login form only. Credentials are NEVER read from the URL — query-string
    // passwords leak into browser history, server logs, and referrer headers.
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

  state.index = await secureFetch("/data/wris/index.json");
  const ix = state.index;
  const totalStations = ix.variables.reduce((a, v) => a + v.n_stations, 0);
  const scope = ix.scope === "ganga" ? "Ganga basin" : "All India";
  $("#hdr-meta").textContent = `${scope} · ${ix.variables.length} variables · ${totalStations.toLocaleString()} stations · monthly · built ${ix.generated}`;

  $("#variable-select").innerHTML = ix.variables
    .map((v) => `<option value="${v.slug}">${v.name} (${v.n_stations})</option>`).join("");
  $("#variable-select").onchange = (e) => loadVariable(e.target.value);

  $("#state-select").onchange = (e) => { state.selState = e.target.value; const r = filtered(); state.station = r[0] || state.station; renderAll(); };
  $("#station-search").oninput = (e) => { state.search = e.target.value; renderList(); };

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
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { renderAll(); if (mapObj) mapObj.invalidateSize(); }, 160); });

  // default to the richest variable (groundwater), else the first
  const first = ix.variables.find((v) => v.slug === "ground_water_level") || ix.variables[0];
  $("#variable-select").value = first.slug;
  await loadVariable(first.slug);
}

init().catch((e) => {
  document.querySelector("main").innerHTML =
    `<div class="card"><h2>Failed to load</h2><p class="sub">${e}</p>
     <p class="sub">Run a local server: <code>cd site &amp;&amp; python3 -m http.server 8000</code></p></div>`;
});
