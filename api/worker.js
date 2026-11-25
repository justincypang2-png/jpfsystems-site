// NoLag API — Cloudflare Worker
// 1) POST /event        : the website records one anonymous event (search, click, sort, do-it-for-me)
// 2) GET  /report?key=… : a summary for you (top searches, searches we didn't understand, clicks by shop…)
// 3) GET  /export.csv?key=… : every event as a spreadsheet file
// 4) GET  /search?q=…&area=SE15 : real products (photo, price, stock, delivery) from the shops' own feeds (loaded nightly by
//    engine/import.mjs) plus live eBay listings you can pay for now, grouped by when they arrive
// 5) POST /ask          : the search assistant. Reads a vague search ("tv", "present for dad") and asks one short
//    question with tap-able answers, or returns precise search words. Uses Cloudflare Workers AI (free daily allowance).
// Stores no names, emails, IP addresses or cookies. Postcodes are cut to the area (e.g. "SE15").

const ALLOWED_ORIGINS = ['https://www.jpfsystems.co', 'https://jpfsystems.co'];
const TYPES = ['search', 'click', 'sort', 'doit'];
// Keep only the postcode area: "SE15 4AB" -> "SE15", "SE5 4AB" -> "SE5", "SE5" -> "SE5".
const outward = pc => {
  if (!pc) return null;
  const m = String(pc).toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})?$/);
  return m ? m[1] : null;
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ---------- search assistant: one clarifying question at a time ----------
    if (url.pathname === '/ask' && req.method === 'POST') {
      const reply = b => new Response(JSON.stringify(b), { headers: { ...cors, 'Content-Type': 'application/json' } });
      if (!env.AI || !ALLOWED_ORIGINS.includes(origin)) return reply({ ai: false });
      if (!askAllowed(req.headers.get('CF-Connecting-IP') || '')) return reply({ ai: false, reason: 'busy' });
      let body; try { body = JSON.parse(await req.text()); } catch { return reply({ ai: false }); }
      const q = String(body.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const history = (Array.isArray(body.history) ? body.history : []).slice(-3)
        .map(h => ({ q: String(h.q || '').slice(0, 140), a: String(h.a || '').slice(0, 140) })).filter(h => h.q && h.a);
      if (!q) return reply({ ai: false });
      if (BLOCKED.test(q) || history.some(h => BLOCKED.test(h.a))) return reply({ ai: true, done: true, question: '', options: [], search: '' });
      const user = `They searched: "${q}"` + (history.length ? '\nTheir answers so far:\n' + history.map(h => `- ${h.q} ${h.a}`).join('\n') : '') +
        `\nQuestions asked so far: ${history.length} of 2.`;
      try {
        const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
          messages: [{ role: 'system', content: ASK_PROMPT }, { role: 'user', content: user }],
          response_format: { type: 'json_schema', json_schema: ASK_SCHEMA }, max_tokens: 220, temperature: 0.2,
        });
        let r = out && out.response;
        if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
        if (!r || typeof r !== 'object') return reply({ ai: false });
        const clean = t => String(t || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
        const search = clean(r.search).slice(0, 70);
        const done = !!r.done || history.length >= 2 || !clean(r.question);
        const options = done ? [] : (Array.isArray(r.options) ? r.options : []).map(o => clean(o).slice(0, 30)).filter(Boolean).slice(0, 5);
        return reply({ ai: true, done, question: done ? '' : clean(r.question).slice(0, 120), options, search: search || q });
      } catch { return reply({ ai: false }); }
    }

    // ---------- product search: real products from the shops' own feeds ----------
    if (url.pathname === '/search' && req.method === 'GET') {
      const out = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' } });
      const q = (url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().slice(0, 80);
      const words = q.split(/\s+/).filter(w => w.length > 1).slice(0, 6);
      if (!words.length) return out({ products: [] });
      // Shops write "PlayStation 5" where people type "ps5", so each word also matches what shops call it.
      const SYN = { ps5: ['playstation 5'], ps4: ['playstation 4'], airpod: ['airpods'], telly: ['tv', 'television'], tv: ['television'], tele: ['tv'], hoover: ['vacuum'], nappies: ['nappy'], nappy: ['nappies'], phone: ['smartphone', 'mobile'], mobile: ['phone'], headphones: ['earphones', 'earbuds'], earbuds: ['earphones', 'headphones'], laptop: ['notebook', 'macbook', 'chromebook'], hairdryer: ['hair dryer'], straighteners: ['straightener'], fridge: ['refrigerator'], specs: ['glasses'] };
      const term = w => '(' + [`"${w}"*`, ...(SYN[w] || []).map(s => `"${s}"`)].join(' OR ') + ')';
      const find = match => env.DB.prepare('SELECT p.*, bm25(pfts, 10.0, 4.0, 1.0) AS score FROM pfts JOIN products p ON p.rid = pfts.rowid WHERE pfts MATCH ? ORDER BY score LIMIT 120').bind(match).all().then(r => r.results);
      const area = (url.searchParams.get('area') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^[A-Z]{1,2}\d[A-Z\d]?/)?.[0] || '';
      const livePromise = ebayLive(env, q, area).catch(() => []); // runs while the database is searched
      let rows = [];
      try {
        rows = await find(words.map(term).join(' AND '));
        // Wordy searches ("hdmi cable 2m"): if nothing has every word, accept products with most of them.
        if (!rows.length && words.length > 1) {
          const need = Math.ceil(words.length / 2);
          const has = (name, w) => [w, ...(SYN[w] || [])].some(s => name.includes(s));
          rows = (await find(words.map(term).join(' OR '))).filter(r => words.filter(w => has(r.name.toLowerCase(), w)).length >= need);
        }
      } catch { rows = []; } // tables not filled yet
      // Someone searching "ps5" wants the console, not a controller or a case: accessories go below the real thing.
      const ACC = /\b(case|cases|cover|covers|cable|lead|charger|charging|controller|strap|protector|skin|stand|mount|adapter|replacement|refill|sleeve|holder|bag|grip|dock|tips|decal|sticker|compatible)\b/;
      const wantsAcc = ACC.test(q);
      const seen = new Set(), groups = { today: [], tomorrow: [], unknown: [], later: [] };
      // Live eBay listings: keep only ones that really are the thing searched for, at most 4 per arrival group.
      const has = (name, w) => [w, ...(SYN[w] || [])].some(s => name.includes(s));
      const live = (await livePromise).filter(p => words.every(w => has(p.name.toLowerCase(), w)));
      const liveCount = { today: 0, tomorrow: 0, unknown: 0, later: 0 };
      rows.map(r => ({ ...r, acc: !wantsAcc && ACC.test(r.name.toLowerCase()) ? 1 : 0 }))
        .sort((a, b) => a.acc - b.acc || a.score - b.score || a.price - b.price)
        .forEach(r => {
          const key = r.shop + '|' + r.name.toLowerCase();
          const g = groups[r.speed] || groups.unknown;
          if (seen.has(key) || g.length >= 8) return;
          seen.add(key);
          g.push({ shop: r.shop, name: r.name, brand: r.brand, price: r.price, was: r.was, img: r.img, url: r.url, stock: r.stock, speed: r.speed in groups ? r.speed : 'unknown', cutoff: r.cutoff, arrive: r.arrive, fee: r.dfee, accessory: !!r.acc, updated: r.updated });
        });
      live.map((p, i) => ({ ...p, acc: !wantsAcc && ACC.test(p.name.toLowerCase()) ? 1 : 0, i }))
        .sort((a, b) => a.acc - b.acc || a.i - b.i)
        .forEach(p => {
          const g = groups[p.speed] || groups.unknown;
          const key = 'ebay|' + p.name.toLowerCase();
          if (seen.has(key) || g.length >= 8 || liveCount[p.speed] >= 4) return;
          seen.add(key); liveCount[p.speed]++;
          const { acc, i, ...rest } = p; g.push({ ...rest, accessory: !!acc });
        });
      return out({ products: [...groups.today, ...groups.tomorrow, ...groups.unknown, ...groups.later] });
    }

    // ---------- record an event ----------
    if (url.pathname === '/event' && req.method === 'POST') {
      if (!ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403, headers: cors });
      const body = await req.text();
      if (body.length > 2000) return new Response('too large', { status: 413, headers: cors });
      let e;
      try { e = JSON.parse(body); } catch { return new Response('bad json', { status: 400, headers: cors }); }
      const text = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
      const type = text(e.type, 10);
      if (!TYPES.includes(type)) return new Response('bad type', { status: 400, headers: cors });
      const area = text(e.area, 8);
      await env.DB.prepare(
        'INSERT INTO events (ts, type, typed, understood, matched, area, shop, position, sort, results, session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        new Date().toISOString(),
        type,
        text(e.typed, 120),
        text(e.understood, 120),
        e.matched === true ? 1 : e.matched === false ? 0 : null,
        outward(area),
        text(e.shop, 20),
        Number.isInteger(e.position) ? e.position : null,
        text(e.sort, 10),
        Number.isInteger(e.results) ? e.results : null,
        text(e.session, 16),
      ).run();
      return new Response(null, { status: 204, headers: cors });
    }

    // ---------- reports (protected by your secret key) ----------
    if (url.pathname === '/report' || url.pathname === '/export.csv') {
      if (!env.REPORT_KEY || url.searchParams.get('key') !== env.REPORT_KEY) return new Response('not allowed', { status: 401 });
      const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
      const since = new Date(Date.now() - days * 864e5).toISOString();

      if (url.pathname === '/export.csv') {
        const { results } = await env.DB.prepare('SELECT * FROM events WHERE ts >= ? ORDER BY ts').bind(since).all();
        const cols = ['ts', 'type', 'typed', 'understood', 'matched', 'area', 'shop', 'position', 'sort', 'results', 'session'];
        const cell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
        const csv = [cols.join(',')].concat(results.map(r => cols.map(c => cell(r[c])).join(','))).join('\n');
        return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="nolag-events-${days}d.csv"` } });
      }

      const q = (sql, ...args) => env.DB.prepare(sql).bind(since, ...args).all().then(r => r.results);
      const [byType, visits, topSearches, notUnderstood, clicksByShop, clicksByProduct, doit, byHour, byArea] = await Promise.all([
        q('SELECT type, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY type'),
        q("SELECT COUNT(DISTINCT session) AS visits_that_searched FROM events WHERE ts >= ? AND type = 'search'"),
        q("SELECT COALESCE(understood, typed) AS search, COUNT(*) AS n FROM events WHERE ts >= ? AND type = 'search' GROUP BY 1 ORDER BY n DESC LIMIT 25"),
        q("SELECT LOWER(typed) AS typed, COUNT(*) AS n FROM events WHERE ts >= ? AND type = 'search' AND matched = 0 GROUP BY 1 ORDER BY n DESC LIMIT 25"),
        q("SELECT shop, COUNT(*) AS clicks FROM events WHERE ts >= ? AND type = 'click' GROUP BY shop ORDER BY clicks DESC"),
        q("SELECT understood AS product, shop, COUNT(*) AS clicks, ROUND(AVG(position), 1) AS avg_position FROM events WHERE ts >= ? AND type = 'click' GROUP BY 1, 2 ORDER BY clicks DESC LIMIT 40"),
        q("SELECT understood AS product, COUNT(*) AS n FROM events WHERE ts >= ? AND type = 'doit' GROUP BY 1 ORDER BY n DESC"),
        q("SELECT CAST(strftime('%H', ts) AS INTEGER) AS hour_utc, COUNT(*) AS searches FROM events WHERE ts >= ? AND type = 'search' GROUP BY 1 ORDER BY 1"),
        q("SELECT area, COUNT(*) AS searches FROM events WHERE ts >= ? AND type = 'search' AND area IS NOT NULL GROUP BY area ORDER BY searches DESC LIMIT 20"),
      ]);
      const count = t => (byType.find(r => r.type === t) || {}).n || 0;
      const searches = count('search'), clicks = count('click');
      const report = {
        period_days: days,
        totals: {
          searches,
          visits_that_searched: visits[0]?.visits_that_searched || 0,
          shop_clicks: clicks,
          click_rate: searches ? Math.round((100 * clicks) / searches) + '%' : '0%',
          do_it_for_me: count('doit'),
          sort_changes: count('sort'),
        },
        top_searches: topSearches,
        searches_we_did_not_understand: notUnderstood,
        clicks_by_shop: clicksByShop,
        clicks_by_product_and_shop: clicksByProduct,
        do_it_for_me_by_product: doit,
        searches_by_hour_utc: byHour,
        searches_by_area: byArea,
      };
      return new Response(JSON.stringify(report, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    return new Response('NoLag API is running.', { headers: { ...cors, 'Content-Type': 'text/plain' } });
  },
};

// ---------- live listings from eBay's free Browse API ----------
// Items people can pay for straight away, with the seller's own delivery estimate to the searcher's area.
// Switched on by three Worker secrets: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and optionally EPN_CAMPAIGN_ID (eBay Partner Network, for commission).
let EBAY_TOKEN = null, EBAY_EXP = 0;
const LIVE_CACHE = new Map(); // 15-minute memory per search, to stay well inside 5,000 calls a day
async function ebayToken(env) {
  if (EBAY_TOKEN && Date.now() < EBAY_EXP) return EBAY_TOKEN;
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(env.EBAY_CLIENT_ID + ':' + env.EBAY_CLIENT_SECRET) },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('eBay sign-in failed');
  EBAY_TOKEN = j.access_token; EBAY_EXP = Date.now() + (j.expires_in - 120) * 1000;
  return EBAY_TOKEN;
}
const londonDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d); // 2026-11-25
const shortDate = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' }).format(d);
async function ebayLive(env, q, area) {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET || !q) return [];
  const key = q + '|' + area, hit = LIVE_CACHE.get(key);
  if (hit && Date.now() - hit.t < 15 * 60 * 1000) return hit.v;
  const token = await ebayToken(env);
  const filter = 'buyingOptions:{FIXED_PRICE},conditions:{NEW},deliveryCountry:GB,itemLocationCountry:GB,priceCurrency:GBP';
  const ctx = 'contextualLocation=' + encodeURIComponent('country=GB,zip=' + (area || 'SE1')) + (env.EPN_CAMPAIGN_ID ? ',affiliateCampaignId=' + env.EPN_CAMPAIGN_ID : '');
  const r = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?limit=50&q=' + encodeURIComponent(q) + '&filter=' + encodeURIComponent(filter), {
    headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB', 'X-EBAY-C-ENDUSERCTX': ctx },
  });
  if (!r.ok) return [];
  const j = await r.json(), today = londonDate(new Date()), tomorrow = londonDate(new Date(Date.now() + 864e5));
  const v = (j.itemSummaries || []).map(it => {
    const opts = (it.shippingOptions || []).filter(o => o.maxEstimatedDeliveryDate).sort((a, b) => a.maxEstimatedDeliveryDate.localeCompare(b.maxEstimatedDeliveryDate));
    const so = opts[0] || (it.shippingOptions || [])[0] || {};
    const maxD = so.maxEstimatedDeliveryDate ? new Date(so.maxEstimatedDeliveryDate) : null, max = maxD ? londonDate(maxD) : null;
    const speed = !max ? 'unknown' : max <= today ? 'today' : max <= tomorrow ? 'tomorrow' : 'later';
    const cost = so.shippingCost ? Number(so.shippingCost.value) : null;
    return {
      shop: 'eBay', seller: it.seller?.username || '', name: String(it.title || '').slice(0, 200), price: Number(it.price?.value),
      img: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || '', url: it.itemAffiliateWebUrl || it.itemWebUrl,
      stock: 'in', speed, cutoff: null, live: true, arriveDate: max,
      arrive: !maxD ? '' : speed === 'later' ? 'by ' + shortDate(maxD) + ' (seller’s estimate)' : 'seller’s estimate',
      fee: cost === 0 ? 'Free delivery' : cost != null ? `£${cost.toFixed(2)} delivery` : '',
    };
  }).filter(p => p.price > 0 && p.url && p.name);
  if (LIVE_CACHE.size > 500) LIVE_CACHE.clear();
  LIVE_CACHE.set(key, { t: Date.now(), v });
  return v;
}

// ---------- search assistant settings ----------
const BLOCKED = /\b(beers?|wines?|vodka|gin|whiske?y|rum|spirits?|alcohol|lager|cider|cigarettes?|cigars?|tobacco|nicotine|vapes?|vaping|e-?cigs?|knife|knives|weapon|gun|drugs?)\b/i;
const ASK_PROMPT = `You help people in London find an item they need delivered today. They typed a search into a shopping site.
Decide whether it is specific enough to search shops for. Specific enough means a shopper could pick the right product: for example "PS5 DualSense controller", "43 inch smart TV", "65W USB-C laptop charger", "red roses bouquet".
If it is not specific enough, ask ONE short, friendly question (under 12 words) about the most important missing detail: what type, what size, what it must fit or work with, or who it is for. Give 2 to 5 short answer options (each under 25 characters) that a person can tap. Do not ask about price, colour or brand unless it truly decides the product.
Ask at most 2 questions in total. When the item is clear, or 2 questions have been answered, set done to true, leave question empty and options empty.
Always set "search" to the best plain search words so far, under 60 characters, for example "43 inch smart TV". Keep any brand or model the person gave.
Never mention prices, stock, shops or delivery times. Write in British English.`;
const ASK_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    search: { type: 'string' },
  },
  required: ['done', 'question', 'options', 'search'],
};
// A light per-visitor limit so one person can't use up the free daily AI allowance: 20 questions a minute.
const ASK_HITS = new Map();
function askAllowed(ip) {
  const now = Date.now(), k = ip || 'unknown', h = (ASK_HITS.get(k) || []).filter(t => now - t < 60000);
  if (h.length >= 20) return false;
  h.push(now); ASK_HITS.set(k, h);
  if (ASK_HITS.size > 5000) ASK_HITS.clear();
  return true;
}
