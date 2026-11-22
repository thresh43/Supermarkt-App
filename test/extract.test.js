// Checks the page parser against markup shaped like the real kaufDA / MeinProspekt pages.
const assert = require("assert");
const fs = require("fs");
const lib = fs.readFileSync(__dirname + "/../src/lib.js", "utf8");
const api = new Function(lib + "; return { extractOffers, matchLevel, chainOf, watchSearch, searchOffers, slugWords, locationCookie, SOURCES };")();
const d = n => new Date(Date.now() + n * 864e5);
const dm = x => String(x.getDate()).padStart(2, "0") + "." + String(x.getMonth() + 1).padStart(2, "0") + ".";
const range = (a, b) => `Mo. ${dm(d(a))} - Sa. ${dm(d(b))}${d(b).getFullYear()}`;
const [KD, MP] = api.SOURCES;

const kdCard = (brand, title, shop, price, extra) => `<div tabindex="0" role="listitem"><div><img alt="x" title="y" loading="lazy" src="https://img/${title}.jpg"/></div>
  <div><button type="button"></button><div><p class="a">${brand}</p><p class="b">${title}</p><p>${shop}</p></div><div><div><p> ${price} €</p><p>${extra || "<span> </span>"}</p></div><p>(1 l = 1.98)</p></div></div></div>`;
const kdFlyer = (shop, a, b) => `<div data-testid="BrochureBox_Basic"><div class="t">Monster Energy bei ${shop}</div><div class="x"><div class="y">&quot;Angebote&quot;, Seite 3</div><div class="z">${range(a, b)}</div><div>Gültig</div></div></div>`;
const kdPage = `<html><script type="application/ld+json">{"itemListElement":[{"@type":"SaleEvent","endDate":"${d(5).toISOString().slice(0, 10)}","performer":{"name":"Trinkgut"}}]}</script>
  ${kdFlyer("Netto Marken-Discount", -8, -2)}${kdFlyer("Penny", -3, 2)}${kdFlyer("Norma", 1, 6)}
  <section data-testid="OfferGrid" id="OfferGrid"><div role="list">
  ${kdCard("Monster", "Energy Drink Zero Zucker", "Netto Marken-Discount", "0,88")}
  ${kdCard("Monster", "Energy-Drink", "Penny", "ab 0,89", "<span>UVP</span><span>1,59 €</span>")}
  ${kdCard("Monster", "Energy-Drink", "Penny", "ab 0,89")}
  ${kdCard("Monster", "Energy Drink Ultra White", "Norma", "0,95")}
  ${kdCard("Monster", "Energy Drink", "Trinkgut", "0,99")}
  </div></section><script>{"city":"Köln","lat":50.94,"lng":6.96,"zip":"50667"}</script></html>`;
let o = api.extractOffers(kdPage, KD, "https://p");
assert.deepStrictEqual(o.map(x => x.retailer + " " + x.price), ["PENNY 0.89", "NORMA 0.95", "trinkgut 0.99"], "expired flyer and duplicates are dropped");
assert.deepStrictEqual([o[0].brand, o[0].title, o[0].oldPrice, o[0].chain, o[0].desc], ["Monster", "Energy-Drink", 1.59, "penny", "1 l = 1.98"]);
assert.ok(new Date(o[0].to) > new Date() && new Date(o[0].from) < new Date());
assert.ok(new Date(o[1].from) > new Date(), "flyer that starts tomorrow keeps its start date");
assert.ok(o[2].to, "structured data fills in a chain without a flyer card");

// MeinProspekt: retailer first, flyer dates in <p> lines
const mpPage = `<div role="listitem"><div><p>REWE</p><p>Dein Markt</p><p>${range(1, 6)}</p></div></div>
  <section id="OfferGrid"><h2>x</h2><div role="list"><div tabindex="0" role="listitem"><div><img alt="a" src="https://img/1.jpg"/></div><div><div><p>REWE</p><p>Kerrygold</p><p>Original Irische Butter</p></div><div><div><p> 1,59 €</p></div><p>(1 kg = 6.36)</p></div></div></div>
  <div tabindex="0" role="listitem"><div><div><p>Marktkauf</p><p></p><p>MONSTER ENERGY DRINK</p></div><div><div><p> 0,99 €</p></div><p>(1 l = 1.98)</p></div></div></div>
  <div tabindex="0" role="listitem"><div><div><p>REWE</p><p></p><p>Monster Truck</p></div><div><div><p> 8,99 €</p></div></div></div></div></div></section>`;
o = api.extractOffers(mpPage, MP, "https://p");
assert.deepStrictEqual(o.map(x => [x.retailer, x.brand, x.title, x.price].join("|")), ["REWE|Kerrygold|Original Irische Butter|1.59", "Marktkauf||MONSTER ENERGY DRINK|0.99", "REWE||Monster Truck|8.99"]);
assert.strictEqual(o[0].from.slice(0, 4), String(d(1).getFullYear()));
assert.strictEqual(api.extractOffers("<html>nothing</html>", KD, "u").length, 0);

assert.strictEqual(api.matchLevel(o[0], "kerrygold butter"), 2);
assert.strictEqual(api.matchLevel(o[0], "butter salz"), 1);
assert.strictEqual(api.chainOf("ALDI SÜD").key, "aldi");
assert.strictEqual(api.chainOf("Netto Marken-Discount").key, "netto");
assert.strictEqual(api.chainOf("E center").key, "edeka");
assert.deepStrictEqual(api.slugWords("Käse & Weißbrot"), ["kaese", "weissbrot"]);
assert.ok(decodeURIComponent(api.locationCookie({ lat: 50.94, lon: 6.96, zip: "50667", label: "50667 Köln" })).includes('"city":"Köln"'));

// Keyword fallback, location cookie, and the watch rules
(async () => {
  const calls = [];
  const get = async (url, cookie) => { calls.push([url, cookie]); return /Monster-Energy$/.test(url) ? { status: 200, text: kdPage } : /angebote\/monster-energy$/.test(url) ? { status: 200, text: mpPage } : { status: 404, text: "" }; };
  const r = await api.watchSearch("Monster Energy Ultra White", { lat: 50.94, lon: 6.96, zip: "50667", label: "50667 Köln" }, get);
  assert.deepStrictEqual(calls.map(c => c[0].split(".de")[1]), ["/Angebote/Monster-Energy-Ultra-White", "/Angebote/Monster-energy-ultra-white", "/Angebote/Monster-Energy", "/angebote/monster-energy-ultra-white", "/angebote/monster-energy"]);
  assert.ok(calls[0][1].startsWith("location="));
  assert.deepStrictEqual(r.exact.map(x => x.retailer), ["NORMA"]);
  assert.deepStrictEqual(r.maybe.map(x => x.retailer).sort(), ["Marktkauf", "PENNY", "trinkgut"], "toys and other brands are not reported");
  assert.strictEqual(r.report[0].place, "50667 Köln");
  assert.strictEqual(r.report[0].found, 3);
  console.log("ok");
})().catch(e => { console.error(e); process.exit(1); });
