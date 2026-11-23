// App UI. Shared helpers (searchOffers, watchSearch, chainOf, ...) come from lib.js.
const $ = id => document.getElementById(id);
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugin = n => (isNative ? Cap.registerPlugin(n) : null);
const LN = plugin("LocalNotifications"), BR = plugin("BackgroundRunner"), GEO = plugin("Geolocation");
const RUNNER = "de.tobi.angebotsradar.watch";
const UA = { "User-Agent": "Angebotsradar/0.1 (private Android app)" };

const S = Object.assign({ loc: null, radius: 5, watch: ["Monster Energy Ultra White"], notify: false, stores: {}, open: {}, watchQ: {} },
  JSON.parse(localStorage.getItem("state") || "{}"));
if (S.watch[0] === "Monster Ultra White") S.watch[0] = "Monster Energy Ultra White"; // first releases used a term the sources do not know
if (!S.stores || S.stores.list) S.stores = {}; // older releases cached one big store list
const save = () => localStorage.setItem("state", JSON.stringify(S));
let stores = [];          // stores inside the radius, nearest first
let lastSearch = null;    // { q, offers }
let watchHits = {};       // term -> { exact, maybe } | { error }
let reports = [];

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const km = d => d.toFixed(d < 10 ? 1 : 0).replace(".", ",") + " km";
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500); }

// The sources localize their pages through a cookie. Browsers do not let fetch() set one, so the
// app calls the native HTTP plugin directly.
async function httpGet(url, cookie) {
  const headers = { Accept: "text/html" };
  if (cookie) headers.Cookie = cookie;
  if (isNative && Cap.Plugins && Cap.Plugins.CapacitorHttp) {
    const r = await Cap.Plugins.CapacitorHttp.request({ url, method: "GET", headers, responseType: "text" });
    return { status: r.status, text: typeof r.data === "string" ? r.data : JSON.stringify(r.data) };
  }
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
  S.loc = loc; S.stores = {}; lookups = {}; save();
  $("locdlg").close(); $("locmsg").textContent = "";
  refresh();
}

// Stores are looked up per chain, only for chains that have an offer, and cached for a week:
// S.stores = { chainKey: { at, r, list } } where r is the radius the lookup covered.
let lookups = {};                    // chainKey -> "busy" | "failed"
let lookupQueue = Promise.resolve(); // the address service allows one request per second
const known = chain => { const c = S.stores[chain]; return !!c && c.r >= S.radius && Date.now() - c.at < 6048e5; };
async function findStores(chain, label) {
  const { lat, lon } = S.loc, list = [], seen = {};
  // A small box first: results are capped and unsorted, so a wide box can miss the nearest store.
  for (const r of S.radius > 4 ? [4, S.radius] : [S.radius]) {
    const dLat = r / 111, dLon = r / (111 * Math.cos(lat * Math.PI / 180));
    const box = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map(n => n.toFixed(4)).join(",");
    const res = await fetch("https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=40&bounded=1&viewbox=" + box + "&q=" + encodeURIComponent(label), { headers: UA });
    if (!res.ok) throw new Error("HTTP " + res.status);
    for (const h of await res.json()) {
      const c = chainOf(h.name);
      if (h.class !== "shop" || !c || c.key !== chain || seen[h.place_id]) continue;
      seen[h.place_id] = 1;
      const a = h.address || {};
      list.push({ chain, name: h.name, lat: +h.lat, lon: +h.lon,
        addr: [[a.road, a.house_number].filter(Boolean).join(" "), a.city || a.town || a.village || a.suburb].filter(Boolean).join(", ") });
    }
    if (list.length) break;
    await new Promise(ok => setTimeout(ok, 1100));
  }
  S.stores[chain] = { at: Date.now(), r: S.radius, list }; save();
}
// Looks up the stores for the chains of these offers, one after the other, and redraws as they arrive.
function ensureStores(offers) {
  if (!S.loc) return;
  for (const o of offers) {
    if (known(o.chain) || lookups[o.chain] === "busy") continue;
    lookups[o.chain] = "busy";
    lookupQueue = lookupQueue.then(async () => {
      try { await findStores(o.chain, o.retailer); delete lookups[o.chain]; }
      catch (e) { lookups[o.chain] = "failed"; }
      applyRadius(); renderWatch(); renderResults(); renderStores(); syncRunner();
      await new Promise(ok => setTimeout(ok, 1100));
    });
  }
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
const displayName = o => (o.brand && fold(o.title).indexOf(fold(o.brand)) < 0 ? o.brand + " " + o.title : o.title);
const watchButton = name => (S.watch.indexOf(name) >= 0 ? `<button class="add" disabled>✓ Beobachtet</button>`
  : `<button class="add" data-watch="${esc(name)}">+ Beobachten</button>`);
// `canWatch` adds the button that puts the product on the watch list (search results only).
function offerCard(o, note, canWatch) {
  const st = nearest(o.chain), v = validity(o);
  const img = o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : `<div class="ph">%</div>`;
  const title = displayName(o), sub = o.desc;
  const watch = canWatch ? watchButton(title) : "";
  return `<article class="card offer">${img}
    <div><div class="t">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    <div class="price">${fmtPrice(o.price)}${o.oldPrice && o.oldPrice > o.price ? `<s>${fmtPrice(o.oldPrice)}</s>` : ""}</div>
    <div class="meta"><span class="tag">${esc(o.retailer)}</span><span class="tag${v.soon ? " warn" : ""}">${esc(v.text)}</span>
      ${note ? `<span class="tag warn">${esc(note)}</span>` : ""}
      <a class="sub" href="${esc(o.url)}" target="_blank" rel="noopener">Quelle: ${esc(o.source)}</a></div>
    <div class="foot">${st
      ? `<div class="sub">${esc(st.name)} · ${km(st.km)}${st.addr ? "<br>" + esc(st.addr) : ""}</div><div class="acts">${watch}<a class="route" href="${routeUrl(st)}" target="_blank" rel="noopener">Route</a></div>`
      : `<div class="sub">${!S.loc ? "Standort wählen, um den nächsten Markt zu sehen" : lookups[o.chain] === "failed" ? "Nächster Markt konnte nicht ermittelt werden"
        : known(o.chain) ? "Kein Markt dieser Kette im Umkreis" : `<span class="spin"></span>Nächster Markt wird gesucht …`}</div>${watch}`}</div>
  </article>`;
}
// Offers at chains with a store in the radius, nearest store first. An offer stays visible while
// its chain is still being looked up or the lookup failed, so a broken map service hides nothing.
function inRadius(list) {
  if (!S.loc) return list.slice();
  const dist = o => { const st = nearest(o.chain); return st ? st.km : 999; };
  return list.filter(o => nearest(o.chain) || !known(o.chain)).sort((a, b) => (b.rank || 0) - (a.rank || 0) || dist(a) - dist(b) || a.price - b.price);
}

// Each watched product is a collapsible block: the summary shows the name and the number of offers.
function renderWatch() {
  const rows = S.watch.map((term, i) => {
    const h = watchHits[term];
    let body = `<p class="muted"><span class="spin"></span>wird geprüft …</p>`, count = "…";
    if (h && h.error) { body = `<p class="muted">Prüfung fehlgeschlagen: ${esc(h.error)}</p>`; count = "!"; }
    else if (h) {
      const ex = inRadius(h.exact), mb = inRadius(h.maybe);
      body = ex.map(o => offerCard(o)).join("") + mb.map(o => offerCard(o, "Sorte im Markt prüfen")).join("");
      if (!body) body = `<p class="muted">Aktuell kein Angebot im Umkreis gefunden.</p>`;
      count = ex.length + mb.length;
    }
    return `<details class="fold" data-term="${esc(term)}" ${S.open[term] ? "open" : ""}><summary><span class="arrow"></span><b>${esc(term)}</b>
      <span class="tag${count === 0 ? " none" : ""}">${count}</span><button class="x" data-del="${i}" aria-label="Entfernen">×</button></summary>${body}</details>`;
  }).join("");
  $("watch").innerHTML = `<div class="head"><h2>Beobachtet</h2>
      <label class="switch"><input type="checkbox" id="notify" ${S.notify ? "checked" : ""}>Benachrichtigen</label></div>
    ${rows || `<p class="muted">Noch nichts auf der Liste. Suche oben ein Produkt und tippe auf „Beobachten“.</p>`}`;
}
function renderResults() {
  if (!lastSearch) { $("results").innerHTML = ""; return; }
  if (lastSearch.loading) { $("results").innerHTML = `<h2>Suche</h2><p class="muted"><span class="spin"></span>„${esc(lastSearch.q)}“ wird gesucht …</p>`; return; }
  const all = lastSearch.offers, near = inRadius(all), far = all.length - near.length;
  $("results").innerHTML = `<div class="head"><h2>${near.length} Angebot${near.length === 1 ? "" : "e"} für „${esc(lastSearch.q)}“</h2>${watchButton(lastSearch.q)}</div>`
    + (near.map(o => offerCard(o, "", true)).join("") || `<p class="muted">Kein Angebot im Umkreis von ${S.radius} km gefunden.</p>`)
    + (far > 0 ? `<p class="muted">${far} weitere${far === 1 ? "s" : ""} Angebot${far === 1 ? "" : "e"} bei Ketten ohne Markt im Umkreis.</p>` : "");
}
function renderStores() {
  if (!S.loc) { $("stores").innerHTML = `<h2>Märkte im Umkreis</h2><p class="muted">Wähle oben deinen Standort, damit Angebote auf Märkte in deiner Nähe eingegrenzt werden.</p>`; return; }
  const seen = {}, rows = [];
  for (const s of stores) { if (seen[s.chain]) continue; seen[s.chain] = 1; rows.push(s); }
  $("stores").innerHTML = rows.length ? `<h2>Märkte mit Angeboten im Umkreis</h2><div class="card">${rows.map(s =>
    `<div class="row"><div><div class="t">${esc(s.name)}</div><div class="sub">${km(s.km)}${s.addr ? " · " + esc(s.addr) : ""}</div></div>
     <a class="route" href="${routeUrl(s)}" target="_blank" rel="noopener">Route</a></div>`).join("")}</div>` : "";
}
function renderDiag() {
  $("diag-body").innerHTML = reports.length ? reports.map(r =>
    `<div>${esc(r.source)}: ${r.error ? "Fehler – " + esc(r.error) : r.found + " Angebote gelesen" + (r.place ? " für " + esc(r.place) : "")}<br><span class="sub">${esc(r.url)}</span></div>`).join("")
    : "Noch keine Abfrage.";
}
function render() {
  $("loc").textContent = S.loc ? "📍 " + S.loc.label : "Standort wählen";
  $("radius").value = S.radius; $("rv").textContent = S.radius + " km";
  renderWatch(); renderResults(); renderDiag();
}

/* ---------- actions ---------- */
function applyRadius() {
  stores = [];
  if (!S.loc) return;
  for (const chain in S.stores) for (const s of S.stores[chain].list) {
    const d = distanceKm(S.loc.lat, S.loc.lon, s.lat, s.lon);
    if (d <= S.radius) stores.push(Object.assign({ km: d }, s));
  }
  stores.sort((a, b) => a.km - b.km);
}
// Chains that were looked up and have no store inside the radius.
const farChains = () => Object.keys(S.stores).filter(c => known(c) && !nearest(c));
const shownOffers = () => Object.values(watchHits).reduce((all, h) => all.concat(h.exact || [], h.maybe || []), (lastSearch && lastSearch.offers) || []);
function refresh() {
  applyRadius(); render(); renderStores();
  syncRunner();
  checkWatch();
}
async function checkWatch() {
  for (const term of S.watch) {
    try { const r = await watchSearch(term, S.loc, httpGet, S.watchQ[term], farChains()); watchHits[term] = r; reports = r.report; }
    catch (e) { watchHits[term] = { error: (e && e.message) || String(e) }; }
    renderWatch(); renderDiag();
    ensureStores(shownOffers());
  }
}
async function runSearch(q) {
  lastSearch = { q, loading: true }; renderResults();
  const r = await searchOffers(q, S.loc, httpGet, farChains());
  reports = r.report;
  const offers = r.offers.filter(o => o.full || matchLevel(o, q) > 0);
  for (const o of offers) o.rank = matchLevel(o, q); // offers naming the term come first
  lastSearch = { q, offers };
  renderResults(); renderDiag();
  ensureStores(offers);
  if (!r.offers.length && r.report.every(x => x.error || !x.found)) toast("Die Angebotsquellen haben keine Daten geliefert – siehe Quellen-Status in den Einstellungen.");
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
  const far = farChains();
  try { await BR.dispatchEvent({ label: RUNNER, event: "config", details: { notify: S.notify, watch: S.watch, watchQ: S.watchQ, loc: S.loc, chains, far } }); } catch (e) { /* runner not ready */ }
}

/* ---------- in-app updates (Android app only) ---------- */
// Every push to main builds a GitHub release; the app compares its build number with the latest one.
const REPO = "thresh43/Supermarkt-App";
const Updater = plugin("AppUpdater");
const UPD = { current: "", code: 0, latest: "", avail: null, busy: false, status: "" };
function renderUpdate() {
  $("update").innerHTML = UPD.avail ? `<div class="card"><div class="row"><div><div class="t">Update verfügbar</div>
    <div class="sub">Version ${esc(UPD.avail.name)} · deine Einstellungen bleiben erhalten</div></div>
    <button class="primary" id="doupdate" ${UPD.busy ? "disabled" : ""}>${UPD.busy ? "Lädt …" : "Aktualisieren"}</button></div></div>` : "";
  $("about").innerHTML = `<h2>App</h2><div class="card">
    <div class="row"><span>Installierte Version</span><b>${esc(UPD.current || (Updater ? "…" : "Vorschau"))}</b></div>
    <div class="row"><span>Neueste Version</span><b>${esc(UPD.latest || "–")}</b></div>
    <button class="primary block" id="updatenow" ${UPD.busy || !Updater ? "disabled" : ""}>${UPD.busy ? "Bitte warten …" : UPD.avail ? "Auf Version " + esc(UPD.avail.name) + " aktualisieren" : "Nach Update suchen und installieren"}</button>
    <p class="muted">${esc(UPD.status || (Updater ? "Sucht die neueste Version und installiert sie direkt. Deine Einstellungen bleiben erhalten." : "Updates gibt es nur in der installierten Android-App."))}</p></div>`;
}
// Returns true when the check itself worked.
async function checkUpdate() {
  if (!Updater) return false;
  let ok = true;
  try {
    const v = await Updater.getVersion();
    UPD.current = v.versionName; UPD.code = +v.versionCode;
    const res = await fetch("https://api.github.com/repos/" + REPO + "/releases/latest", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rel = await res.json();
    const n = +String(rel.tag_name || "").split(".").pop();
    const asset = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
    UPD.latest = String(rel.tag_name || "").replace(/^v/, "");
    UPD.avail = n > UPD.code && asset ? { name: UPD.latest, url: asset.browser_download_url } : null;
  } catch (e) { ok = false; UPD.status = "Update-Prüfung fehlgeschlagen (" + ((e && e.message) || e) + ")."; }
  renderUpdate();
  return ok;
}
async function doUpdate() {
  if (!UPD.avail || UPD.busy) return;
  UPD.busy = true; UPD.status = "Version " + UPD.avail.name + " wird heruntergeladen …"; renderUpdate();
  try {
    const r = await Updater.downloadAndInstall({ url: UPD.avail.url });
    UPD.status = r.status === "permission" ? "Bitte erlaube die Installation aus dieser App und tippe danach erneut auf Aktualisieren."
      : "Download fertig – bestätige die Installation im Android-Dialog.";
  } catch (e) { UPD.status = (e && e.message) || "Update fehlgeschlagen."; }
  UPD.busy = false; renderUpdate();
}
// The settings button does both steps: look for a newer version and install it right away.
async function updateNow() {
  if (UPD.busy) return;
  UPD.busy = true; UPD.status = "Suche nach Updates …"; renderUpdate();
  const ok = await checkUpdate();
  UPD.busy = false;
  if (UPD.avail) return doUpdate();
  if (ok) UPD.status = "Du hast bereits die neueste Version.";
  renderUpdate();
}
$("update").addEventListener("click", e => { if (e.target.id === "doupdate") doUpdate(); });
$("about").addEventListener("click", e => { if (e.target.id === "updatenow") updateNow(); });
document.querySelector(".tabs").addEventListener("click", e => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b === e.target);
  $("view-offers").hidden = tab !== "offers"; $("view-settings").hidden = tab !== "settings";
  document.body.classList.toggle("settings", tab === "settings");
  scrollTo(0, 0);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && !UPD.busy) checkUpdate(); });

/* ---------- events ---------- */
$("search").addEventListener("submit", e => { e.preventDefault(); const q = $("q").value.trim(); if (q) { $("q").blur(); runSearch(q); } });
$("q").addEventListener("search", () => { if (!$("q").value) { lastSearch = null; renderResults(); } });
$("radius").addEventListener("input", () => { S.radius = +$("radius").value; $("rv").textContent = S.radius + " km"; });
$("radius").addEventListener("change", () => { save(); applyRadius(); render(); renderStores(); syncRunner(); ensureStores(shownOffers()); });
$("loc").addEventListener("click", () => $("locdlg").showModal());
$("gps").addEventListener("click", useGps);
$("placego").addEventListener("click", usePlace);
$("place").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); usePlace(); } });
$("watch").addEventListener("click", e => {
  const d = e.target.dataset.del;
  if (d != null) { e.preventDefault(); delete watchHits[S.watch[+d]]; delete S.open[S.watch[+d]]; delete S.watchQ[S.watch[+d]]; S.watch.splice(+d, 1); save(); renderWatch(); renderResults(); syncRunner(); }
});
// Remember which products are unfolded ("toggle" does not bubble, hence the capture listener).
$("watch").addEventListener("toggle", e => { const t = e.target.dataset && e.target.dataset.term; if (t) { S.open[t] = e.target.open; save(); } }, true);
$("watch").addEventListener("change", async e => {
  if (e.target.id !== "notify") return;
  S.notify = e.target.checked && (await ensurePerm());
  e.target.checked = S.notify; save(); syncRunner();
  if (S.notify) toast("Du bekommst höchstens einmal am Tag eine Meldung, wenn es ein neues Angebot gibt.");
});
// "Beobachten" in the search results: remember the product together with the search term that found it.
$("results").addEventListener("click", e => {
  const name = e.target.dataset.watch;
  if (!name || S.watch.indexOf(name) >= 0) return;
  S.watch.push(name);
  if (lastSearch && fold(name) !== fold(lastSearch.q)) S.watchQ[name] = lastSearch.q;
  save(); renderWatch(); renderResults(); syncRunner(); checkWatch();
  toast("„" + name + "“ wird jetzt beobachtet.");
});
// Reload everything: watched products, the current search and the app version.
$("reload").addEventListener("click", async () => {
  const btn = $("reload");
  if (btn.classList.contains("busy")) return;
  btn.classList.add("busy");
  try {
    watchHits = {}; renderWatch();
    await Promise.all([checkWatch(), lastSearch && !lastSearch.loading ? runSearch(lastSearch.q) : null, checkUpdate()]);
    toast("Angebote aktualisiert.");
  } catch (e) { toast("Aktualisieren fehlgeschlagen: " + ((e && e.message) || e)); }
  btn.classList.remove("busy");
});

refresh();
renderUpdate();
checkUpdate();
