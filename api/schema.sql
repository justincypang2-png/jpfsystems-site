CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  typed TEXT,
  understood TEXT,
  matched INTEGER,
  area TEXT,
  shop TEXT,
  position INTEGER,
  sort TEXT,
  results INTEGER,
  session TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);

-- Product engine: filled every night by engine/import.mjs from the shops' own product feeds.
CREATE TABLE IF NOT EXISTS products (rid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, shop TEXT, name TEXT, brand TEXT, cat TEXT, price REAL, was REAL, img TEXT, url TEXT, stock TEXT, speed TEXT, cutoff REAL, arrive TEXT, dfee TEXT, h TEXT, updated TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS pfts USING fts5(name, brand, cat, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS shops (name TEXT PRIMARY KEY, feed_id TEXT, products INTEGER, speed TEXT, updated TEXT);

-- Local shops (copied from local-shops.json by the importer) so /search only shows their products where they deliver.
CREATE TABLE IF NOT EXISTS local_shops (id TEXT PRIMARY KEY, name TEXT, areas TEXT, how TEXT, opens REAL, cutoff REAL, days TEXT, fee TEXT, phone TEXT, url TEXT, products INTEGER, list_ok TEXT, updated TEXT);
