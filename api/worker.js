// NoLag API — Cloudflare Worker
// 1) POST /event        : the website records one anonymous event (search, click, sort, do-it-for-me)
// 2) GET  /report?key=… : a summary for you (top searches, searches we didn't understand, clicks by shop…)
// 3) GET  /export.csv?key=… : every event as a spreadsheet file
// 4) GET  /search?q=…    : real products (photo, price, stock, delivery) from the shops' own feeds, loaded nightly by engine/import.mjs
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
      let rows;
      try {
        rows = await find(words.map(term).join(' AND '));
        // Wordy searches ("hdmi cable 2m"): if nothing has every word, accept products with most of them.
        if (!rows.length && words.length > 1) {
          const need = Math.ceil(words.length / 2);
          const has = (name, w) => [w, ...(SYN[w] || [])].some(s => name.includes(s));
          rows = (await find(words.map(term).join(' OR '))).filter(r => words.filter(w => has(r.name.toLowerCase(), w)).length >= need);
        }
      } catch { return out({ products: [] }); } // tables not filled yet
      // Someone searching "ps5" wants the console, not a controller or a case: accessories go below the real thing.
      const ACC = /\b(case|cases|cover|covers|cable|lead|charger|charging|controller|strap|protector|skin|stand|mount|adapter|replacement|refill|sleeve|holder|bag|grip|dock|tips|decal|sticker|compatible)\b/;
      const wantsAcc = ACC.test(q);
      const seen = new Set(), groups = { today: [], tomorrow: [], unknown: [], later: [] };
      rows.map(r => ({ ...r, acc: !wantsAcc && ACC.test(r.name.toLowerCase()) ? 1 : 0 }))
        .sort((a, b) => a.acc - b.acc || a.score - b.score || a.price - b.price)
        .forEach(r => {
          const key = r.shop + '|' + r.name.toLowerCase();
          const g = groups[r.speed] || groups.unknown;
          if (seen.has(key) || g.length >= 8) return;
          seen.add(key);
          g.push({ shop: r.shop, name: r.name, brand: r.brand, price: r.price, was: r.was, img: r.img, url: r.url, stock: r.stock, speed: r.speed in groups ? r.speed : 'unknown', cutoff: r.cutoff, arrive: r.arrive, fee: r.dfee, accessory: !!r.acc, updated: r.updated });
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
