// NoLag product engine: nightly importer.
// 1. Reads your Awin feed list, which names every shop that has approved you. Nothing is typed in by hand.
// 2. Downloads each shop's product feed: names, photos, prices, stock and delivery text.
// 3. Works out how fast each product can arrive (today / tomorrow / later).
// 4. Writes only what changed into your Cloudflare D1 database, where the website's /search reads it.
//
// Settings come from environment variables (GitHub secrets):
//   FEED_LIST_URL          your Awin feed-list link (Awin: Toolbox > Create-a-Feed > feed list download)
//   CLOUDFLARE_API_TOKEN   a Cloudflare token with "D1 Edit" permission
//   CLOUDFLARE_ACCOUNT_ID  your Cloudflare account ID
//   D1_DATABASE_ID         the nolag database ID
// Optional: MAX_CHANGES (default 25000 a night, keeps inside D1's free daily write allowance)
// For local testing: LOCAL_DB=/path/file.sqlite writes to a local SQLite file instead of Cloudflare.

import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const MAX_CHANGES = parseInt(env.MAX_CHANGES || '25000', 10);
const RULES = JSON.parse(readFileSync(join(HERE, 'shops.json'), 'utf8')).shops;
const SKIP = /\b(adult|sex|sexual|erotic|fetish|tobacco|cigar|cigarette|vape|vaping|e-?liquid|alcohol|wine|beer|lager|cider|spirits|whisky|whiskey|vodka|gin|rum|tequila|champagne|prosecco)\b/i;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- CSV ----------
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const first = text.slice(0, text.indexOf('\n') + 1 || text.length);
  const counts = { ',': 0, '|': 0, '\t': 0, ';': 0 };
  for (const ch of first) if (ch in counts) counts[ch]++;
  const d = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === d) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

async function download(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'NoLag feed importer' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      else if (buf[0] === 0x50 && buf[1] === 0x4b) {
        const dir = mkdtempSync(join(tmpdir(), 'feed-')), file = join(dir, 'f.zip');
        writeFileSync(file, buf);
        buf = execFileSync('unzip', ['-p', file], { maxBuffer: 2 ** 31 });
      }
      return buf.toString('utf8');
    } catch (e) {
      log(`  download failed (${e.message}), try ${attempt} of 3`);
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 300000 * (env.FAST_RETRY ? 0 : 1))); // Awin asks for a 5-minute wait
    }
  }
}

// ---------- understanding a feed row ----------
const pick = (r, ...names) => { for (const n of names) if (r[n]) return r[n]; return ''; };
const money = s => { const m = String(s).replace(/,/g, '').match(/\d+(\.\d+)?/); return m ? Math.round(parseFloat(m[0]) * 100) / 100 : null; };
export const ruleFor = shop => RULES.find(r => shop.toLowerCase().includes(r.match)) || null;

// How fast? The shop's own delivery text wins; otherwise our checked facts for that shop; otherwise unknown.
export function speedOf(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/same[\s-]?day|\btoday\b|within \d+\s*(h|hr|hrs|hour|hours|min|mins|minutes)\b|\b\d+\s*(min|mins|minutes)\b|\b1\s*hour/.test(t)) return 'today';
  if (/next[\s-]?(working |business )?day|tomorrow|\b24\s*(h|hr|hrs|hours)\b/.test(t)) return 'tomorrow';
  let m = t.match(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:working |business )?(day|days|week|weeks)/);
  if (m) return /week/.test(m[3]) || +m[2] > 1 ? 'later' : 'tomorrow';
  m = t.match(/(\d+)\s*(?:working |business )?(day|days|week|weeks)/);
  if (m) return /week/.test(m[2]) ? 'later' : +m[1] <= 1 ? 'tomorrow' : 'later';
  return null;
}

export function stockOf(r) {
  const s = pick(r, 'stock_status', 'availability', 'in_stock', 'is_for_sale').toLowerCase();
  const n = parseInt(pick(r, 'stock_quantity', 'number_available'), 10);
  if (/out|^0$|^no$|^false$|unavailable|discontinued/.test(s) || n === 0) return 'out';
  if (/pre-?order|backorder/.test(s)) return 'out';
  if (/limited|low/.test(s) || (n > 0 && n < 5)) return 'low';
  if (s || n > 0) return 'in';
  return null; // the shop didn't say
}

export function productFrom(r, shopName, feedId) {
  const name = pick(r, 'product_name', 'title').replace(/\s+/g, ' ').slice(0, 200);
  const url = pick(r, 'aw_deep_link', 'deep_link', 'link', 'merchant_deep_link');
  const price = money(pick(r, 'search_price', 'price', 'store_price', 'display_price', 'sale_price'));
  if (!name || !url || price == null || price <= 0) return null;
  const cat = pick(r, 'category_name', 'merchant_category', 'merchant_product_category_path', 'google_product_category', 'product_type').slice(0, 120);
  if (SKIP.test(name) || SKIP.test(cat)) return null;
  const stock = stockOf(r);
  if (stock === 'out') return null; // no use to someone who needs it today
  const shop = pick(r, 'merchant_name') || shopName;
  const rule = ruleFor(shop);
  const dtext = pick(r, 'delivery_time', 'shipping_label').slice(0, 80);
  const was = money(pick(r, 'rrp_price', 'product_price_old', 'base_price'));
  const p = {
    id: `${feedId}:${pick(r, 'aw_product_id', 'product_id', 'id', 'merchant_product_id') || createHash('sha1').update(url).digest('hex').slice(0, 16)}`.slice(0, 80),
    shop: rule?.name || shop.replace(/\s+(UK|GB)$/i, '').slice(0, 60),
    name,
    brand: pick(r, 'brand_name', 'brand').slice(0, 60),
    cat,
    price,
    was: was && was > price ? was : null,
    img: pick(r, 'merchant_image_url', 'large_image', 'aw_image_url', 'image_url', 'image_link'),
    url,
    stock,
    speed: speedOf(dtext) || rule?.speed || 'unknown',
    cutoff: rule?.cutoff ?? null,
    arrive: (speedOf(dtext) ? dtext : rule?.arrive || dtext || '').slice(0, 80),
    dfee: (() => { const c = pick(r, 'delivery_cost', 'shipping'); const v = money(c); return c === '' ? (rule?.fee || '') : v === 0 ? 'Free delivery' : v != null ? `£${v.toFixed(2)} delivery` : c.slice(0, 40); })(),
  };
  p.h = createHash('sha1').update(JSON.stringify(p)).digest('hex').slice(0, 12);
  return p;
}

// ---------- database ----------
const lit = v => v == null || v === '' ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : "'" + String(v).replace(/\u0000/g, '').replace(/'/g, "''") + "'";
let local = null;
async function d1(sql) {
  if (env.LOCAL_DB) {
    if (!local) { const { DatabaseSync } = await import('node:sqlite'); local = new DatabaseSync(env.LOCAL_DB); }
    if (/^\s*select/i.test(sql)) return local.prepare(sql).all();
    local.exec(sql); return [];
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.success) throw new Error('D1: ' + JSON.stringify(j.errors || res.status).slice(0, 300));
  return (j.result || []).at(-1)?.results || [];
}
async function run(statements) { // send in chunks under D1's statement-size limit
  let chunk = '';
  for (const s of statements) {
    if (chunk.length + s.length > 90000) { await d1(chunk); chunk = ''; }
    chunk += s + ';\n';
  }
  if (chunk) await d1(chunk);
}

const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');
const COLS = ['shop', 'name', 'brand', 'cat', 'price', 'was', 'img', 'url', 'stock', 'speed', 'cutoff', 'arrive', 'dfee', 'h'];

export async function main() {
  if (!env.FEED_LIST_URL) { log('No Awin feed list link saved yet (secret AWIN_FEED_LIST_URL). Nothing to import.'); return { changes: 0, removed: 0 }; }
  await run(SCHEMA.split(';').map(s => s.trim()).filter(Boolean));

  log('Reading your Awin feed list');
  const list = parseCSV(await download(env.FEED_LIST_URL));
  const feeds = list.filter(f => {
    const status = (f['membership status'] || '').toLowerCase();
    const region = (f['primary region'] || 'GB').toUpperCase();
    const vertical = (f['vertical'] || 'retail').toLowerCase();
    return f.url && /active|joined/.test(status) && !/not|pending|reject|suspend/.test(status) && /GB|UK/.test(region) && /retail/.test(vertical);
  });
  log(`${list.length} feeds listed, ${feeds.length} from shops that have approved you`);
  const order = { today: 0, tomorrow: 1, unknown: 2, later: 3 };
  feeds.sort((a, b) => (order[ruleFor(a['advertiser name'] || '')?.speed || 'unknown'] - order[ruleFor(b['advertiser name'] || '')?.speed || 'unknown']));

  const existing = new Map((await d1('SELECT rid, id, h, shop FROM products')).map(r => [r.id, r]));
  let nextRid = (await d1('SELECT COALESCE(MAX(rid), 0) AS m FROM products'))[0].m + 1;
  let changes = 0, stoppedEarly = false;
  const seen = new Set(), finishedShops = new Set(), shopRows = [];

  for (const f of feeds) {
    const shopName = f['advertiser name'] || 'Shop';
    if (changes >= MAX_CHANGES) { stoppedEarly = true; log(`Daily write allowance reached; ${shopName} continues tomorrow`); break; }
    log(`${shopName}: downloading feed ${f['feed id']}`);
    let rows;
    try { rows = parseCSV(await download(f.url)); } catch (e) { log(`  skipped: ${e.message}`); continue; }
    const stmts = []; let kept = 0, shop = null, complete = true;
    for (const r of rows) {
      const p = productFrom(r, shopName, f['feed id']);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id); kept++; shop = shop || p.shop;
      const old = existing.get(p.id);
      if (old && old.h === p.h) continue;
      if (changes >= MAX_CHANGES) { complete = false; continue; }
      const rid = old ? old.rid : nextRid++;
      if (old) stmts.push(`UPDATE products SET ${COLS.map(c => `${c}=${lit(p[c])}`).join(',')}, updated=${lit(new Date().toISOString())} WHERE rid=${rid}`, `DELETE FROM pfts WHERE rowid=${rid}`);
      else stmts.push(`INSERT INTO products (rid,id,${COLS.join(',')},updated) VALUES (${rid},${lit(p.id)},${COLS.map(c => lit(p[c])).join(',')},${lit(new Date().toISOString())})`);
      stmts.push(`INSERT INTO pfts (rowid,name,brand,cat) VALUES (${rid},${lit(p.name)},${lit(p.brand)},${lit(p.cat)})`);
      changes++;
    }
    await run(stmts);
    if (complete) finishedShops.add(shop || shopName); else stoppedEarly = true;
    shopRows.push(`INSERT OR REPLACE INTO shops (name, feed_id, products, speed, updated) VALUES (${lit(shop || shopName)},${lit(f['feed id'])},${kept},${lit(ruleFor(shopName)?.speed || 'from feed')},${lit(new Date().toISOString())})`);
    log(`  ${kept} products in stock, ${stmts.length ? 'changes saved' : 'no changes'}`);
  }

  // Remove products that have gone (sold out, delisted, or the shop left) — only for shops fully read this run.
  const activeShops = new Set(feeds.map(f => ruleFor(f['advertiser name'] || '')?.name || (f['advertiser name'] || '').replace(/\s+(UK|GB)$/i, '')));
  const gone = [...existing.values()].filter(r => !seen.has(r.id) && (finishedShops.has(r.shop) || (!stoppedEarly && !activeShops.has(r.shop))));
  await run(gone.flatMap(r => [`DELETE FROM products WHERE rid=${r.rid}`, `DELETE FROM pfts WHERE rowid=${r.rid}`]));
  await run(shopRows);
  log(`Done: ${changes} products added or updated, ${gone.length} removed${stoppedEarly ? ', more to load tomorrow' : ''}`);
  return { changes, removed: gone.length, stoppedEarly };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
