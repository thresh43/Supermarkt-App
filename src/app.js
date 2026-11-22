// App UI. Shared helpers (searchOffers, watchSearch, chainOf, ...) come from lib.js.
const $ = id => document.getElementById(id);
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugin = n => (isNative && Cap.registerPlugin ? Cap.registerPlugin(n) : null);
const LN = plugin("LocalNotifications"), BR = plugin("BackgroundRunner"), GEO = plugin("Geolocation");
const RUNNER = "de.tobi.angebotsradar.watch";
const UA = { "User-Agent": "Angebotsradar/0.1 (private Android app)" };

const S = Object.assign({ loc: null, radius: 5, watch: ["Monster Ultra White"], notify: false, stores: null },
  JSON.parse(localStorage.getItem("state") || "{}"));
const save = () => localStorage.setItem("state", JSON.stringify(S));
let stores = [];          // stores inside the radius, nearest first
let lastSearch = null;    // { q, offers }
let watchHits = {};       // term -> { exact, maybe } | { error }
let reports = [];

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const km = d => d.toFixed(d < 10 ? 1 : 0).replace(".", ",") + " km";
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500); }

async function httpGet(url) {
  const res = await fetch(url, { headers: { Accept: "text/html" } });
  return { status: res.status, text: await res.text() };
}

/* ---------- location and stores ---------- */
async function useGps() {
  $("locmsg").textContent = "Standort wird ermittelt …";
  try {
    let c;
    if (GEO) {
      let p = await GEO.checkPermissions();
      if (p.location !== "granted" && p.coarseLocation !== "granted") p = await GEO.requestPermissions();
      if (p.location !== "granted" && p.coarseLocation !== "granted") throw new Error("Standortzugriff wurde nicht erlaubt.");
      c = (await GEO.getCurrentPosition({ enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 })).coords;
    } else {
      c = (await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { timeout: 15000, maximumAge: 300000 }))).coords;
    }
    const loc = { lat: c.latitude, lon: c.longitude, label: "Mein Standort", zip: "" };
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${loc.lat}&lon=${loc.lon}`, { headers: UA });
      const a = (await r.json()).address || {};
      loc.zip = a.postcode || "";
      loc.label = [a.postcode, a.city || a.town || a.village || a.municipality].filter(Boolean).join(" ") || loc.label;
    } catch (e) { /* the position alone is enough */ }
    setLocation(loc);
  } catch (e) { $("locmsg").textContent = "Standort nicht verfügbar: " + ((e && e.message) || e); }
}
async function usePlace() {
  const v = $("place").value.trim();
  if (!v) return;
  $("locmsg").textContent = "Suche …";
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=de&q=" + encodeURIComponent(v), { headers: UA });
    const hit = (await r.json())[0];
    if (!hit) throw new Error("Ort nicht gefunden.");
    const a = hit.address || {};
    const zip = a.postcode || (/^\d{5}$/.test(v) ? v : "");
    setLocation({ lat: +hit.lat, lon: +hit.lon, zip, label: [zip, a.city || a.town || a.village || a.municipality].filter(Boolean).join(" ") || v });
  } catch (e) { $("locmsg").textContent = (e && e.message) || String(e); }
}
function setLocation(loc) {
  S.loc = loc; S.stores = null; save();
  $("locdlg").close(); $("locmsg").textContent = "";
  refresh();
}

// All shops within 25 km are fetched once per location and cached for a day; the radius filters locally.
async function loadStores() {
  const c = S.stores;
  if (c && Date.now() - c.at < 864e5) return c.list;
  const q = `[out:json][timeout:25];nwr["shop"~"^(supermarket|convenience|beverages|chemist|wholesale)$"](around:25000,${S.loc.lat},${S.loc.lon});out center tags;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const list = [];
  for (const e of (await res.json()).elements || []) {
    const t = e.tags || {}, lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
    const chain = chainOf(t.brand || t.name || t.operator);
    if (!chain || lat == null) continue;
    const addr = [[t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), t["addr:city"]].filter(Boolean).join(", ");
    list.push({ chain: chain.key, name: t.name || chain.label, addr, lat, lon });
  }
  S.stores = { at: Date.now(), list }; save();
  return list;
}
function nearest(chain) { return stores.find(s => s.chain === chain) || null; }
const routeUrl = s => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving&dir_action=navigate`;

/* ---------- rendering ---------- */
function validity(o) {
  const now = Date.now(), fmt = d => new Date(d).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  if (o.from && new Date(o.from).getTime() > now) return { text: "ab " + fmt(o.from) + (o.to ? " bis " + fmt(o.to) : ""), soon: false };
  if (!o.to) return { text: "Laufzeit unbekannt", soon: false };
  const days = Math.floor((new Date(o.to).getTime() - now) / 864e5);
  const left = days <= 0 ? "endet heute" : days === 1 ? "noch 1 Tag" : "noch " + days + " Tage";
  return { text: left + " · bis " + fmt(o.to), soon: days <= 1 };
}
function offerCard(o, note) {
  const st = nearest(o.chain), v = validity(o);
  const img = o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : `<div class="ph">%</div>`;
  const sub = [o.brand && fold(o.title).indexOf(fold(o.brand)) < 0 ? o.brand : "", o.desc].filter(Boolean).join(" · ");
  return `<article class="card offer">${img}
    <div><div class="t">${esc(o.title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    <div class="price">${fmtPrice(o.price)}${o.oldPrice && o.oldPrice > o.price ? `<s>${fmtPrice(o.oldPrice)}</s>` : ""}</div>
    <div class="meta"><span class="tag">${esc(o.retailer)}</span><span class="tag${v.soon ? " warn" : ""}">${esc(v.text)}</span>
      ${note ? `<span class="tag warn">${esc(note)}</span>` : ""}
      <a class="sub" href="${esc(o.url)}" target="_blank" rel="noopener">Quelle: ${esc(o.source)}</a></div>
    <div class="foot">${st
      ? `<div class="sub">${esc(st.name)} · ${km(st.km)}${st.addr ? "<br>" + esc(st.addr) : ""}</div><a class="route" href="${routeUrl(st)}" target="_blank" rel="noopener">Route</a>`
      : `<div class="sub">${S.loc ? "Kein Markt dieser Kette im Umkreis" : "Standort wählen, um den nächsten Markt zu sehen"}</div>`}</div>
  </article>`;
}
// Offers at chains with a store in the radius, nearest store first. Without a location everything is shown.
function inRadius(list) {
  if (!S.loc) return list.slice();
  return list.filter(o => nearest(o.chain)).sort((a, b) => nearest(a.chain).km - nearest(b.chain).km || a.price - b.price);
}

function renderWatch() {
  const rows = S.watch.map((term, i) => {
    const h = watchHits[term];
    let body = `<p class="muted"><span class="spin"></span>wird geprüft …</p>`;
    if (h && h.error) body = `<p class="muted">Prüfung fehlgeschlagen: ${esc(h.error)}</p>`;
    else if (h) {
      const ex = inRadius(h.exact), mb = inRadius(h.maybe);
      body = ex.map(o => offerCard(o)).join("") + mb.map(o => offerCard(o, "Sorte im Markt prüfen")).join("");
      if (!body) body = `<p class="muted">Aktuell kein Angebot im Umkreis gefunden.</p>`;
    }
    return `<div class="head"><b>${esc(term)}</b><button class="x" data-del="${i}" aria-label="Entfernen">×</button></div>${body}`;
  }).join("");
  $("watch").innerHTML = `<div class="head"><h2>Beobachtet</h2>
      <label class="switch"><input type="checkbox" id="notify" ${S.notify ? "checked" : ""}>Benachrichtigen</label></div>
    ${rows || `<p class="muted">Noch nichts auf der Liste.</p>`}
    <form id="addwatch" class="search"><input id="wq" placeholder="Produkt beobachten" autocomplete="off"><button type="submit">+</button></form>`;
}
function renderResults() {
  if (!lastSearch) { $("results").innerHTML = ""; return; }
  if (lastSearch.loading) { $("results").innerHTML = `<h2>Suche</h2><p class="muted"><span class="spin"></span>„${esc(lastSearch.q)}“ wird gesucht …</p>`; return; }
  const all = lastSearch.offers, near = inRadius(all), far = all.length - near.length;
  $("results").innerHTML = `<h2>${near.length} Angebot${near.length === 1 ? "" : "e"} für „${esc(lastSearch.q)}“</h2>`
    + (near.map(o => offerCard(o)).join("") || `<p class="muted">Kein Angebot im Umkreis von ${S.radius} km gefunden.</p>`)
    + (far > 0 ? `<p class="muted">${far} weitere${far === 1 ? "s" : ""} Angebot${far === 1 ? "" : "e"} bei Ketten ohne Markt im Umkreis.</p>` : "");
}
function renderStores(error) {
  if (!S.loc) { $("stores").innerHTML = `<h2>Märkte im Umkreis</h2><p class="muted">Wähle oben deinen Standort, damit Angebote auf Märkte in deiner Nähe eingegrenzt werden.</p>`; return; }
  if (error) { $("stores").innerHTML = `<h2>Märkte im Umkreis</h2><p class="muted">Märkte konnten nicht geladen werden (${esc(error)}).</p><button class="ghost" id="retry">Erneut versuchen</button>`; return; }
  const seen = {}, rows = [];
  for (const s of stores) { if (seen[s.chain]) continue; seen[s.chain] = 1; rows.push(s); }
  $("stores").innerHTML = `<h2>Märkte im Umkreis · ${rows.length} Ketten</h2>` + (rows.length ? `<div class="card">${rows.map(s =>
    `<div class="row"><div><div class="t">${esc(s.name)}</div><div class="sub">${km(s.km)}${s.addr ? " · " + esc(s.addr) : ""}</div></div>
     <a class="route" href="${routeUrl(s)}" target="_blank" rel="noopener">Route</a></div>`).join("")}</div>`
    : `<p class="muted">Kein Markt im Umkreis von ${S.radius} km gefunden.</p>`);
}
function renderDiag() {
  $("diag-body").innerHTML = reports.length ? reports.map(r =>
    `<div>${esc(r.source)}: ${r.error ? "Fehler – " + esc(r.error) : r.found + " Angebote gelesen"}<br><span class="sub">${esc(r.url)}</span></div>`).join("")
    : "Noch keine Abfrage.";
}
function render() {
  $("loc").textContent = S.loc ? "📍 " + S.loc.label : "Standort wählen";
  $("radius").value = S.radius; $("rv").textContent = S.radius + " km";
  renderWatch(); renderResults(); renderDiag();
}

/* ---------- actions ---------- */
function applyRadius() {
  const all = (S.stores && S.stores.list) || [];
  stores = S.loc ? all.map(s => Object.assign({}, s, { km: distanceKm(S.loc.lat, S.loc.lon, s.lat, s.lon) }))
    .filter(s => s.km <= S.radius).sort((a, b) => a.km - b.km) : [];
}
async function refresh() {
  applyRadius(); render(); renderStores();
  if (S.loc) {
    try { await loadStores(); applyRadius(); render(); renderStores(); }
    catch (e) { renderStores((e && e.message) || String(e)); }
  }
  syncRunner();
  checkWatch();
}
async function checkWatch() {
  for (const term of S.watch) {
    try { const r = await watchSearch(term, S.loc ? S.loc.zip : "", httpGet); watchHits[term] = r; reports = r.report; }
    catch (e) { watchHits[term] = { error: (e && e.message) || String(e) }; }
    renderWatch(); renderDiag();
  }
}
async function runSearch(q) {
  lastSearch = { q, loading: true }; renderResults();
  const r = await searchOffers(q, S.loc ? S.loc.zip : "", httpGet);
  reports = r.report;
  const offers = r.offers.filter(o => matchLevel(o, q) > 0).sort((a, b) => matchLevel(b, q) - matchLevel(a, q));
  lastSearch = { q, offers };
  renderResults(); renderDiag();
  if (!r.offers.length && r.report.every(x => x.error || !x.found)) toast("Die Angebotsquellen haben keine Daten geliefert – siehe Quellen-Status.");
}

/* ---------- notifications ---------- */
async function ensurePerm() {
  if (!LN) { toast("Benachrichtigungen gibt es nur in der Android-App."); return false; }
  try {
    let p = await LN.checkPermissions();
    if (p.display !== "granted") p = await LN.requestPermissions();
    if (p.display !== "granted") { toast("Benachrichtigungen sind in den Android-Einstellungen blockiert."); return false; }
    try { await LN.createChannel({ id: "offers", name: "Angebote", description: "Beobachtete Produkte im Angebot", importance: 4, visibility: 1 }); } catch (e) { /* exists */ }
    return true;
  } catch (e) { return false; }
}
// Hands the watch list and the chains inside the radius to the background task.
async function syncRunner() {
  if (!BR) return;
  const chains = {};
  for (const s of stores) if (!chains[s.chain]) chains[s.chain] = { km: s.km };
  try { await BR.dispatchEvent({ label: RUNNER, event: "config", details: { notify: S.notify, watch: S.watch, zip: S.loc ? S.loc.zip : "", chains } }); } catch (e) { /* runner not ready */ }
}

/* ---------- events ---------- */
$("search").addEventListener("submit", e => { e.preventDefault(); const q = $("q").value.trim(); if (q) { $("q").blur(); runSearch(q); } });
$("q").addEventListener("search", () => { if (!$("q").value) { lastSearch = null; renderResults(); } });
$("radius").addEventListener("input", () => { S.radius = +$("radius").value; $("rv").textContent = S.radius + " km"; });
$("radius").addEventListener("change", () => { save(); applyRadius(); render(); renderStores(); syncRunner(); });
$("loc").addEventListener("click", () => $("locdlg").showModal());
$("gps").addEventListener("click", useGps);
$("placego").addEventListener("click", usePlace);
$("place").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); usePlace(); } });
$("stores").addEventListener("click", e => { if (e.target.id === "retry") refresh(); });
$("watch").addEventListener("click", e => {
  const d = e.target.dataset.del;
  if (d != null) { delete watchHits[S.watch[+d]]; S.watch.splice(+d, 1); save(); renderWatch(); syncRunner(); }
});
$("watch").addEventListener("change", async e => {
  if (e.target.id !== "notify") return;
  S.notify = e.target.checked && (await ensurePerm());
  e.target.checked = S.notify; save(); syncRunner();
  if (S.notify) toast("Du wirst benachrichtigt, sobald ein beobachtetes Produkt im Angebot ist.");
});
$("watch").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("wq").value.trim();
  if (v && S.watch.indexOf(v) < 0) { S.watch.push(v); save(); renderWatch(); syncRunner(); checkWatch(); }
});

refresh();
