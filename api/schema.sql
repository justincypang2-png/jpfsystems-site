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
