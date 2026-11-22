// Background task (Capacitor Background Runner). Android wakes it about once an hour; it checks
// the watched products at most once a day and posts one notification per product that has new
// offers at a chain with a store inside the radius.
// build-web.js prepends src/lib.js, so watchSearch and friends are available here.

function kvGet(k, def) {
  try { const r = CapacitorKV.get(k); return r && r.value != null && r.value !== "" ? r.value : def; } catch (e) { return def; }
}
async function httpGet(url, cookie) {
  const headers = { Accept: "text/html" };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers });
  return { status: res.status, text: await res.text() };
}

addEventListener("checkOffers", async (resolve, reject) => {
  try {
    const cfg = JSON.parse(kvGet("cfg", "{}"));
    if (!cfg.notify || !cfg.watch || !cfg.watch.length) return resolve();
    const now = new Date(), today = now.toISOString().slice(0, 10), hour = now.getUTCHours();
    // Once a day, and not at night (06-19 UTC is morning to evening in Germany).
    if (kvGet("day", "") === today || hour < 6 || hour > 19) return resolve();
    const seen = JSON.parse(kvGet("seen", "[]"));
    const chains = cfg.chains || {}, far = cfg.far || [];
    const list = [];
    let reached = false;
    for (const term of cfg.watch) {
      const r = await watchSearch(term, cfg.loc || null, httpGet, (cfg.watchQ || {})[term]);
      if (r.report.some(x => !x.error)) reached = true;
      const lines = [];
      for (const o of r.exact.concat(r.maybe)) {
        if (seen.indexOf(o.id) >= 0 || far.indexOf(o.chain) >= 0) continue;
        seen.push(o.id);
        const st = chains[o.chain];
        lines.push(o.retailer + " " + fmtPrice(o.price) + (o.to ? " bis " + o.to.slice(8, 10) + "." + o.to.slice(5, 7) + "." : "")
          + (st ? " · " + st.km.toFixed(1).replace(".", ",") + " km" : ""));
      }
      if (!lines.length) continue;
      list.push({
        id: hash(term + today) % 2000000000, title: term + ": " + (lines.length === 1 ? "neues Angebot" : lines.length + " neue Angebote"),
        body: lines.slice(0, 3).join(" | "), largeBody: lines.slice(0, 8).join("\n"), channelId: "offers", smallIcon: "ic_stat_offer",
        scheduleAt: new Date(Date.now() + 1500 + list.length * 500),
      });
    }
    // Only count the day as done when a source answered; otherwise try again on the next wake-up.
    if (reached) { CapacitorKV.set("day", today); CapacitorKV.set("seen", JSON.stringify(seen.slice(-500))); }
    if (list.length) CapacitorNotifications.schedule(list);
    resolve();
  } catch (e) { reject(e); }
});

addEventListener("config", (resolve, reject, args) => {
  try {
    const d = (args && (args.details || args)) || {};
    CapacitorKV.set("cfg", JSON.stringify(d));
    resolve();
  } catch (e) { reject(e); }
});
