// Checks the page parser against the embedded-data shapes offer sites commonly use.
const assert = require("assert");
const fs = require("fs");
const lib = fs.readFileSync(__dirname + "/../src/lib.js", "utf8");
const api = new Function(lib + "; return { extractOffers, matchLevel, isAssortment, chainOf, watchSearch, SOURCES };")();
const day = n => new Date(Date.now() + n * 864e5).toISOString();
const src = { name: "test" };

// schema.org JSON-LD: Product with nested Offer
const ld = `<html><script type="application/ld+json">${JSON.stringify({ "@type": "ItemList", itemListElement: [{ "@type": "Product",
  name: "Monster Energy Ultra White", brand: { name: "Monster" }, image: "https://x/i.jpg",
  offers: { "@type": "Offer", price: "0.99", validFrom: day(-1), priceValidUntil: day(3).slice(0, 10), seller: { name: "Lidl" } } }] })}</script></html>`;
let o = api.extractOffers(ld, src, "https://p");
assert.strictEqual(o.length, 1);
assert.deepStrictEqual([o[0].title, o[0].price, o[0].chain, o[0].retailer, o[0].image], ["Monster Energy Ultra White", 0.99, "lidl", "Lidl", "https://x/i.jpg"]);
assert.ok(new Date(o[0].to) > new Date());

// Framework state blob: offers with advertisers[] and validityDates[]
const next = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { results: [
  { id: 1, product: { name: "Energy Drink" }, brand: { name: "Monster" }, description: "versch. Sorten, je 0,5-l-Dose", price: 0.88, oldPrice: 1.49,
    advertisers: [{ name: "Kaufland" }], validityDates: [{ from: day(-2), to: day(4) }] },
  { id: 2, product: { name: "Alte Cola" }, price: 0.5, advertisers: [{ name: "REWE" }], validityDates: [{ from: day(-9), to: day(-2) }] },
  { id: 3, product: { name: "Ohne Händler" }, price: 0.5 }] } } })}</script>`;
o = api.extractOffers(next, src, "https://p");
assert.strictEqual(o.length, 1, "expired and seller-less entries are dropped");
assert.deepStrictEqual([o[0].title, o[0].brand, o[0].price, o[0].oldPrice, o[0].chain], ["Energy Drink", "Monster", 0.88, 1.49, "kaufland"]);
assert.strictEqual(api.matchLevel(o[0], "monster ultra white"), 1);
assert.strictEqual(api.matchLevel(o[0], "monster"), 2);
assert.ok(api.isAssortment(o[0]));

assert.strictEqual(api.extractOffers("<html><script>var a=1</script>nothing</html>", src, "u").length, 0);
assert.strictEqual(api.chainOf("ALDI SÜD").key, "aldi");
assert.strictEqual(api.chainOf("Netto Marken-Discount").key, "netto");
assert.strictEqual(api.chainOf("E-Center Müller").key, "edeka");

// Watch search: exact hit plus a range offer of the same brand
(async () => {
  const get = async url => ({ status: 200, text: /ultra/i.test(url) ? ld : next });
  const r = await api.watchSearch("Monster Ultra White", "", get);
  assert.deepStrictEqual([r.exact.length, r.maybe.length], [1, 1]);
  assert.strictEqual(r.maybe[0].chain, "kaufland");
  console.log("ok");
})().catch(e => { console.error(e); process.exit(1); });
