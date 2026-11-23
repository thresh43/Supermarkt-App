// Shared logic for the app and the background runner. No DOM, no imports:
// build-web.js inlines this file into both bundles.

// Offer sources: kaufDA and MeinProspekt (both Bonial). They have one page per product keyword
// ("/Angebote/Monster-Energy") and localize it through a "location" cookie. `order` says which of
// the three text lines of an offer card is the retailer, the brand and the product name.
const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
const SOURCES = [
  { id: "kaufda", name: "kaufDA", order: { brand: 0, title: 1, retailer: 2 },
    url: (words, variant) => "https://www.kaufda.de/Angebote/" + (variant ? cap(words.join("-")) : words.map(cap).join("-")), variants: 2 },
  { id: "meinprospekt", name: "MeinProspekt", order: { retailer: 0, brand: 1, title: 2 },
    url: words => "https://www.meinprospekt.de/angebote/" + words.join("-"), variants: 1 },
];

// kaufDA also has one page per retailer and keyword ("/Trinkgut/Sortiment/Bier"). The general
// keyword page only shows its top offers, often from one or two chains, so these pages are read
// as well: the big supermarkets and discounters plus the beverage markets. [page name, chain key]
const RETAILER_PAGES = [
  ["REWE", "rewe"], ["Edeka", "edeka"], ["E-center", "edeka"], ["Aldi-Sued", "aldi"], ["Aldi-Nord", "aldi"], ["Lidl", "lidl"],
  ["Penny-Markt", "penny"], ["Netto-Marken-Discount", "netto"], ["Kaufland", "kaufland"], ["Norma", "norma"], ["Marktkauf", "marktkauf"],
  ["Globus", "globus"], ["tegut", "tegut"], ["HIT-Markt", "hit"],
  ["Trinkgut", "trinkgut"], ["Getraenke-Hoffmann", "hoffmann"], ["Netto-Getraenke-Discount", "netto"],
];

// "Käse Aufschnitt" -> ["kaese", "aufschnitt"]
function slugWords(q) {
  return String(q).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}
function locationCookie(loc) {
  if (!loc) return "";
  const city = String(loc.city || loc.label || "").replace(/^\d{5}\s*/, "");
  return "location=" + encodeURIComponent(JSON.stringify({ city, cityDisplayName: city, countryCode: "DE", lat: loc.lat, lng: loc.lon, zip: loc.zip || "" }));
}

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
  return String(s).replace(/&quot;/g, '"').replace(/&#x27;|&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function num(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = /\d+(?:[.,]\d+)?/.exec(v.replace(/\.(?=\d{3}\b)/g, ""));
  return m ? parseFloat(m[0].replace(",", ".")) : null;
}
function endOfDay(isoDate) { return isoDate ? isoDate.slice(0, 10) + "T23:59:59" : null; }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

// Validity per chain. The pages state it per flyer, not per offer: in the flyer cards
// ("Mo. 23.11. - Sa. 28.11.2026") and, less precisely, in the structured data.
function validityByChain(html) {
  const map = {};
  const put = (name, from, to) => {
    const c = chainOf(name);
    if (c && to && !map[c.key]) map[c.key] = { from: from || null, to: endOfDay(to) };
  };
  const walk = n => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const who = n.seller || n.performer, to = n.priceValidUntil || n.endDate;
    if (who && who.name && typeof to === "string") put(who.name, typeof n.startDate === "string" ? n.startDate : null, to);
    for (const k in n) walk(n[k]);
  };
  const range = "[^<]*?(\\d\\d)\\.(\\d\\d)\\. - [^<]*?(\\d\\d)\\.(\\d\\d)\\.(\\d{4})<";
  const cards = [
    new RegExp("<p[^>]*>([^<]{2,60})</p>(?:<p[^>]*>[^<]*</p>)?<p[^>]*>" + range, "g"),          // MeinProspekt
    new RegExp(" bei ([^<]{2,60})</div><div[^>]*><div[^>]*>[^<]*</div><div[^>]*>" + range, "g"), // kaufDA
    // kaufDA retailer page: title="Bier Angebot im Trinkgut Prospekt, gültig von 23.11.2026 bis 28.11.2026"
    /()()()()()() im ([^"<,]{2,60}?) Prospekt, gültig von (\d\d)\.(\d\d)\.(\d{4}) bis (\d\d)\.(\d\d)\.(\d{4})/g,
  ];
  let m;
  for (const card of cards) while ((m = card.exec(html))) {
    if (m[7]) { put(decodeEntities(m[7]), m[10] + "-" + m[9] + "-" + m[8], m[13] + "-" + m[12] + "-" + m[11]); continue; }
    const fromYear = +m[3] > +m[5] ? +m[6] - 1 : +m[6];
    put(decodeEntities(m[1]), fromYear + "-" + m[3] + "-" + m[2], m[6] + "-" + m[5] + "-" + m[4]);
  }
  // Fallback for chains without a flyer card on the page.
  const ld = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g;
  while ((m = ld.exec(html))) { try { walk(JSON.parse(m[1])); } catch (e) { /* skip broken block */ } }
  return map;
}

// "Monster Energy" + "Energy Drink" and "Monster" + "Energy-Drink" are the same product.
function nameKey(brand, title) {
  return fold(brand + " " + title).split(" ").filter((w, i, a) => a.indexOf(w) === i).sort().join(" ");
}

// Parse the offer cards of one page into normalized offers.
function extractOffers(html, source, pageUrl) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
  const grids = body.match(/id="OfferGrid[^"]*"[\s\S]*?<\/section>/g); // also "OfferGrid_Main" on retailer pages
  if (!grids) return [];
  const valid = validityByChain(html), seen = {}, out = [], now = Date.now();
  for (const item of grids.join("").split('role="listitem"').slice(1)) {
    const lines = [];
    const re = /<p[^>]*>([^<]*)<\/p>/g;
    let m;
    while ((m = re.exec(item))) lines.push(decodeEntities(m[1]).trim());
    const priceLine = lines.slice(3).find(l => /\d\s*€/.test(l));
    const price = priceLine ? num(priceLine) : null;
    const chain = chainOf(lines[source.order.retailer]);
    const title = lines[source.order.title], brand = lines[source.order.brand] || "";
    if (!chain || !title || price == null) continue;
    const v = valid[chain.key] || {};
    if (v.to && new Date(v.to).getTime() < now) continue;
    const key = [nameKey(brand, title), chain.key, price].join("|");
    if (seen[key]) continue;
    seen[key] = 1;
    const unit = lines.slice(3).find(l => /=|\/\s*(l|kg)/.test(l) && l !== priceLine) || "";
    const uvp = /UVP<\/span><span[^>]*>([^<]*)</.exec(item);
    const img = /<img[^>]*\ssrc="(https?:[^"]+)"/.exec(item);
    out.push({
      id: hash(key + "|" + (v.to || "")), title, brand, desc: unit.replace(/^\(|\)$/g, ""), price, oldPrice: uvp ? num(uvp[1]) : null,
      from: v.from || null, to: v.to || null, chain: chain.key, retailer: chain.label,
      image: img ? decodeEntities(img[1]) : "", source: source.name, url: pageUrl,
    });
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
// Fetch all sources for one term. A source only knows keyword pages, so the term is tried as a
// whole first and then shortened ("monster ultra white" -> "monster ultra" -> "monster").
// Returns { offers, report } - report says what each source delivered.
// `skipChains`: chains known to have no store in the radius; their retailer pages are not fetched.
async function searchOffers(query, loc, httpGet, skipChains) {
  const words = slugWords(query), offers = [], report = [], seen = {};
  const add = (list, entry, full) => {
    for (const o of list) {
      entry.found++;
      o.full = full;
      const k = [nameKey(o.brand, o.title), o.chain, o.price].join("|");
      if (!seen[k]) { seen[k] = 1; offers.push(o); }
    }
  };
  const cookie = locationCookie(loc);
  for (const src of SOURCES) {
    const entry = { source: src.name, url: "", status: 0, found: 0, error: "", place: "" };
    let extra = null;
    try {
      let page = null;
      for (let n = words.length; n > 0 && !page; n = n > 2 ? 2 : n - 1) {
        for (let variant = 0; variant < (n > 1 ? src.variants : 1) && !page; variant++) {
          entry.url = src.url(words.slice(0, n), variant);
          const res = await httpGet(entry.url, cookie);
          entry.status = res.status;
          if (res.status >= 200 && res.status < 300) page = { text: res.text, full: n === words.length };
          else if (res.status !== 404) throw new Error("HTTP " + res.status);
        }
      }
      if (!page) entry.error = "kein Treffer für diesen Begriff";
      else {
        const place = /"city":"([^"]*)"[^{}]*?"zip":"([^"]*)"/.exec(page.text);
        entry.place = place ? place[2] + " " + place[1] : "";
        add(extractOffers(page.text, src, entry.url), entry, page.full);
        if (src.id === "kaufda") extra = await retailerPages(src, entry.url.split("/").pop(), page.full);
      }
    } catch (e) { entry.error = String((e && e.message) || e); }
    report.push(entry);
    if (extra) report.push(extra);
  }
  return { offers, report };

  async function retailerPages(src, keyword, full) {
    const entry = { source: src.name + " Händlerseiten", url: "", status: 200, found: 0, error: "", place: "" };
    const pages = RETAILER_PAGES.filter(p => !skipChains || skipChains.indexOf(p[1]) < 0);
    let hits = 0;
    for (let i = 0; i < pages.length; i += 4) {
      await Promise.all(pages.slice(i, i + 4).map(async p => {
        const url = "https://www.kaufda.de/" + p[0] + "/Sortiment/" + keyword;
        try {
          const res = await httpGet(url, cookie);
          if (res.status < 200 || res.status >= 300) return;
          hits++;
          // The page also lists other retailers; keep only this retailer's own offers.
          add(extractOffers(res.text, src, url).filter(o => o.chain === p[1]), entry, full);
        } catch (e) { /* one missing retailer page does not matter */ }
      }));
    }
    entry.url = hits + " von " + pages.length + " Händlerseiten hatten den Begriff";
    return entry;
  }
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Search for a watched product. `exact` names the product in full; `maybe` is an offer of the
// same brand where the flyer does not name the variant, so it has to be checked in the store.
// `query` is the search term whose page listed the product, if it was added from search results.
async function watchSearch(term, loc, httpGet, query, skipChains) {
  const words = fold(term).split(" ").filter(Boolean);
  const r = await searchOffers(query || term, loc, httpGet, skipChains);
  const exact = [], maybe = [];
  const score = o => { const hay = fold(o.brand + " " + o.title); return words.filter(w => hay.indexOf(w) >= 0).length; };
  for (const o of r.offers) {
    if (matchLevel(o, term) === 2) exact.push(o);
    // Same brand; without a brand line only groceries count (they carry a unit price, toys do not).
    else if (words.length > 1 && (o.brand ? fold(o.brand).indexOf(words[0]) === 0 : o.desc && fold(o.title).indexOf(words[0]) === 0)) maybe.push(o);
  }
  maybe.sort((a, b) => score(b) - score(a));
  return { exact, maybe, report: r.report };
}

function fmtPrice(p) { return p.toFixed(2).replace(".", ",") + " €"; }
