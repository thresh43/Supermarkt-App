// Shared logic for the app and the background runner. No DOM, no imports:
// build-web.js inlines this file into both bundles.

// Offer sources: public search pages of offer aggregators. `url` builds the page for a search term.
const SOURCES = [
  { id: "marktguru", name: "marktguru", url: (q, zip) => "https://www.marktguru.de/search/" + encodeURIComponent(q) + (zip ? "?zipCode=" + zip : "") },
  { id: "kaufda", name: "kaufDA", url: (q, zip) => "https://www.kaufda.de/Angebote/" + encodeURIComponent(q) + (zip ? "?zip=" + zip : "") },
];

// Known chains: [key, display name, pattern on the folded name]
const CHAINS = [
  ["aldi", "ALDI", /\baldi\b/], ["lidl", "Lidl", /\blidl\b/], ["rewe", "REWE", /\brewe\b/],
  ["edeka", "EDEKA", /\bedeka\b|\be center\b|\be aktiv\b|\be neukauf\b/], ["netto", "Netto", /\bnetto\b/],
  ["penny", "PENNY", /\bpenny\b/], ["kaufland", "Kaufland", /\bkaufland\b/], ["norma", "NORMA", /\bnorma\b/],
  ["globus", "Globus", /\bglobus\b/], ["marktkauf", "Marktkauf", /\bmarktkauf\b/], ["hit", "HIT", /\bhit\b/],
  ["tegut", "tegut", /\btegut\b/], ["famila", "famila", /\bfamila\b/], ["combi", "Combi", /\bcombi\b/],
  ["nahkauf", "nahkauf", /\bnahkauf\b/], ["real", "real", /\breal\b/], ["trinkgut", "trinkgut", /\btrinkgut\b/],
  ["hoffmann", "Getränke Hoffmann", /\bgetranke hoffmann\b/], ["rossmann", "ROSSMANN", /\brossmann\b/],
  ["dm", "dm", /\bdm\b/], ["mueller", "Müller", /\bmuller\b/], ["action", "Action", /\baction\b/],
  ["philipps", "Thomas Philipps", /\bthomas philipps\b/], ["metro", "METRO", /\bmetro\b/],
  ["selgros", "Selgros", /\bselgros\b/], ["vmarkt", "V-Markt", /\bv markt\b/], ["wasgau", "WASGAU", /\bwasgau\b/],
  ["feneberg", "Feneberg", /\bfeneberg\b/], ["denns", "Denns", /\bdenn s\b|\bdenns\b/], ["alnatura", "Alnatura", /\balnatura\b/],
];

// Lowercase, strip accents and punctuation: "Getränke-Hoffmann" -> "getranke hoffmann"
function fold(s) {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ").trim();
}
function chainOf(name) {
  const f = fold(name);
  if (!f) return null;
  for (const [key, label, re] of CHAINS) if (re.test(f)) return { key, label };
  return { key: f, label: String(name).trim() };
}

function decodeEntities(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v.replace(/\.(?=\d{3}\b)/g, ""));
  return m ? parseFloat(m[0].replace(",", ".")) : null;
}
function str(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) return str(v.name || v.title || v.label || "");
  return "";
}
function first(o, keys) {
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return null;
}
function toDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") v = v < 1e11 ? v * 1000 : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Collect every JSON document embedded in a page: JSON-LD, framework state blobs, inline assignments.
function jsonBlobs(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1], body = m[2].trim();
    if (!body || /\bsrc\s*=/.test(attrs)) continue;
    let text = null;
    if (/json/i.test(attrs)) text = body;
    else {
      const a = /=\s*([{[][\s\S]*[}\]])\s*;?\s*$/.exec(body);
      if (a && /price|preis/i.test(a[1])) text = a[1];
    }
    if (!text) continue;
    try { out.push(JSON.parse(text)); } catch (e) {
      try { out.push(JSON.parse(decodeEntities(text))); } catch (e2) { /* not JSON */ }
    }
  }
  return out;
}

const NAME_KEYS = ["name", "title", "productName", "headline"];
const PRICE_KEYS = ["price", "salesPrice", "currentPrice", "offerPrice", "lowPrice", "priceValue"];
const OLD_KEYS = ["oldPrice", "referencePrice", "regularPrice", "originalPrice", "strikePrice", "highPrice"];
const SELLER_KEYS = ["seller", "advertiser", "retailer", "merchant", "publisher", "store", "offeredBy", "shop"];
const FROM_KEYS = ["validFrom", "priceValidFrom", "startDate", "validFromDate", "from", "dateFrom"];
const TO_KEYS = ["validThrough", "priceValidUntil", "validUntil", "validTo", "endDate", "validToDate", "to", "dateTo"];

function sellerOf(o) {
  let v = first(o, SELLER_KEYS);
  if (v == null && Array.isArray(o.advertisers)) v = o.advertisers[0];
  if (v == null && Array.isArray(o.retailers)) v = o.retailers[0];
  if (Array.isArray(v)) v = v[0];
  return str(v);
}
function validityOf(o) {
  let from = toDate(first(o, FROM_KEYS)), to = toDate(first(o, TO_KEYS));
  const list = o.validityDates || o.validity || o.validityPeriods;
  const arr = Array.isArray(list) ? list : list && typeof list === "object" ? [list] : [];
  if (arr.length) {
    from = from || toDate(first(arr[0], FROM_KEYS));
    to = to || toDate(first(arr[arr.length - 1], TO_KEYS));
  }
  return { from, to };
}
function imageOf(o) {
  let v = first(o, ["image", "imageUrl", "thumbnail", "thumbnailUrl", "picture"]);
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === "object") v = v.url || v.contentUrl || v.src;
  return typeof v === "string" && /^https?:/.test(v) ? v : "";
}

// Walk any JSON tree and collect things that look like a priced offer from a retailer.
function collectOffers(node, ctx, out, depth) {
  if (!node || typeof node !== "object" || depth > 40) return;
  if (Array.isArray(node)) { for (const x of node) collectOffers(x, ctx, out, depth + 1); return; }
  const seller = sellerOf(node) || ctx.seller;
  const name = str(first(node, NAME_KEYS)) || str(node.product) || ctx.name;
  const brand = str(node.brand) || str(node.product && node.product.brand) || ctx.brand;
  const nested = node.offers && typeof node.offers === "object";
  let price = num(first(node, PRICE_KEYS));
  if (price == null && node.price && typeof node.price === "object") price = num(first(node.price, ["value", "amount", "price"]));
  if (price != null && price > 0 && name && seller && !nested) {
    const v = validityOf(node);
    const desc = str(node.description) || ctx.desc;
    out.push({
      title: name, brand, desc: desc === name ? "" : desc, price,
      oldPrice: num(first(node, OLD_KEYS)), retailer: seller,
      from: v.from || ctx.from, to: v.to || ctx.to,
      image: imageOf(node) || ctx.image, url: typeof node.url === "string" && /^https?:/.test(node.url) ? node.url : "",
    });
  }
  const v = validityOf(node);
  const next = {
    seller, name, brand, desc: str(node.description) || ctx.desc,
    from: v.from || ctx.from, to: v.to || ctx.to, image: imageOf(node) || ctx.image,
  };
  for (const k in node) if (node[k] && typeof node[k] === "object") collectOffers(node[k], next, out, depth + 1);
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

// Parse one page into normalized, de-duplicated offers that are still valid.
function extractOffers(html, source, pageUrl) {
  const raw = [];
  for (const blob of jsonBlobs(html)) collectOffers(blob, {}, raw, 0);
  const seen = {}, out = [], now = Date.now();
  for (const o of raw) {
    if (o.to) {
      // A date without a time means "until the end of that day".
      const end = new Date(o.to);
      if (end.getUTCHours() === 0 && end.getUTCMinutes() === 0) end.setTime(end.getTime() + 86399000);
      o.to = end.toISOString();
      if (end.getTime() < now) continue;
    }
    const chain = chainOf(o.retailer);
    if (!chain) continue;
    const key = [fold(o.title), chain.key, o.price, (o.to || "").slice(0, 10)].join("|");
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(Object.assign(o, { id: hash(key), chain: chain.key, retailer: chain.label, source: source.name, url: o.url || pageUrl }));
  }
  return out;
}

// How well an offer matches a search term: 2 = every word found, 1 = some words, 0 = none.
function matchLevel(offer, query) {
  const words = fold(query).split(" ").filter(Boolean);
  if (!words.length) return 2;
  const hay = " " + fold([offer.title, offer.brand, offer.desc].join(" ")) + " ";
  let hit = 0;
  for (const w of words) if (hay.indexOf(w) >= 0) hit++;
  return hit === words.length ? 2 : hit > 0 ? 1 : 0;
}
// Flyers often advertise a whole range ("versch. Sorten") without naming the variant.
function isAssortment(offer) {
  return /versch|sorten|alle varianten|div\b|je \d/.test(fold([offer.title, offer.desc].join(" ")).replace(/ /g, " "));
}

// Fetch all sources for one term. Returns { offers, report } - report says what each source delivered.
async function searchOffers(query, zip, httpGet) {
  const offers = [], report = [], seen = {};
  for (const src of SOURCES) {
    const url = src.url(query, zip);
    const entry = { source: src.name, url, status: 0, found: 0, error: "" };
    try {
      const res = await httpGet(url);
      entry.status = res.status;
      if (res.status >= 200 && res.status < 300) {
        for (const o of extractOffers(res.text, src, url)) {
          entry.found++;
          const k = [fold(o.title), o.chain, o.price].join("|");
          if (!seen[k]) { seen[k] = 1; offers.push(o); }
        }
      } else entry.error = "HTTP " + res.status;
    } catch (e) { entry.error = String((e && e.message) || e); }
    report.push(entry);
  }
  return { offers, report };
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Search for a watched product. `exact` names the product; `maybe` is a range offer of the same
// brand ("Monster Energy, versch. Sorten") where the variant has to be checked in the store.
async function watchSearch(term, zip, httpGet) {
  const words = fold(term).split(" ").filter(Boolean);
  const a = await searchOffers(term, zip, httpGet);
  const exact = a.offers.filter(o => matchLevel(o, term) === 2);
  let maybe = [], report = a.report;
  if (words.length > 1) {
    const b = await searchOffers(words[0], zip, httpGet);
    report = report.concat(b.report);
    const ids = {};
    for (const o of exact) ids[o.id] = 1;
    for (const o of a.offers.concat(b.offers)) {
      if (ids[o.id]) continue;
      ids[o.id] = 1;
      if (matchLevel(o, term) === 2) exact.push(o);
      else if (matchLevel(o, words[0]) === 2 && isAssortment(o)) maybe.push(o);
    }
  }
  return { exact, maybe, report };
}

function fmtPrice(p) { return p.toFixed(2).replace(".", ",") + " €"; }
