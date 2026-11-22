// Background task (Capacitor Background Runner): checks the watched products about once an hour
// and posts a notification for every new offer at a chain that has a store inside the radius.
// build-web.js prepends src/lib.js, so searchOffers/watchSearch are available here.

function kvGet(k, def) {
  try { const r = CapacitorKV.get(k); return r && r.value != null && r.value !== "" ? r.value : def; } catch (e) { return def; }
}
async function httpGet(url) {
  const res = await fetch(url, { headers: { Accept: "text/html" } });
  return { status: res.status, text: await res.text() };
}

addEventListener("checkOffers", async (resolve, reject) => {
  try {
    const cfg = JSON.parse(kvGet("cfg", "{}"));
    if (!cfg.notify || !cfg.watch || !cfg.watch.length) return resolve();
    const seen = JSON.parse(kvGet("seen", "[]"));
    const chains = cfg.chains || {};
    const limit = Object.keys(chains).length > 0;
    const list = [];
    for (const term of cfg.watch) {
      const r = await watchSearch(term, cfg.zip || "", httpGet);
      const hits = r.exact.map(o => [o, true]).concat(r.maybe.map(o => [o, false]));
      for (const [o, exact] of hits) {
        if (seen.indexOf(o.id) >= 0 || (limit && !chains[o.chain])) continue;
        seen.push(o.id);
        const st = chains[o.chain];
        const until = o.to ? " · bis " + o.to.slice(8, 10) + "." + o.to.slice(5, 7) + "." : "";
        const body = o.title + " · " + fmtPrice(o.price) + until + (st ? " · " + st.km.toFixed(1).replace(".", ",") + " km" : "");
        list.push({
          id: o.id % 2000000000, title: (exact ? term + " im Angebot" : term + ": evtl. im Angebot") + " · " + o.retailer,
          body, largeBody: body, channelId: "offers", smallIcon: "ic_stat_offer",
          scheduleAt: new Date(Date.now() + 1500 + list.length * 500),
        });
      }
    }
    CapacitorKV.set("seen", JSON.stringify(seen.slice(-500)));
    if (list.length) CapacitorNotifications.schedule(list.slice(0, 5));
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
