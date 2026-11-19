-- pult: the whole D1 schema in one file. Apply once:
--   npx wrangler d1 execute pult --remote --file=schema.sql      (local rehearsal: --local)
-- Every statement is IF NOT EXISTS, so running it again is harmless. A later change goes in as a new numbered file under migrations/.

-- Items: cards, notes, incidents, meetings. The renderer owns the message columns (tg_message_id, msg_state, rendered_hash).
CREATE TABLE IF NOT EXISTS items (
  user_id       INTEGER NOT NULL,                 -- the owner's Telegram id (= private chat id)
  id            TEXT NOT NULL,
  short         TEXT NOT NULL,                    -- sha1(user_id:id)[:10], what callback_data carries
  kind          TEXT NOT NULL CHECK (kind IN ('decision', 'inbox', 'digest', 'incident', 'meeting')),
  urgency       TEXT NOT NULL CHECK (urgency IN ('now', 'today', 'week')),
  state         TEXT NOT NULL CHECK (state IN ('new', 'shown', 'snoozed', 'done', 'dropped', 'expired')),
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  shown_at      INTEGER,
  snooze_until  INTEGER,
  expires_at    INTEGER,
  closed_at     INTEGER,
  source        TEXT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  actions       TEXT NOT NULL DEFAULT '[]',       -- JSON: names from contracts/actions.json
  payload       TEXT,                             -- JSON: link, source_label, copy, fix, start, meta {do, why, cost, verb}, detail
  hash          TEXT NOT NULL,
  loud          INTEGER NOT NULL DEFAULT 0,
  loud_sent_at  INTEGER,                          -- when it rang; one ring per batch
  working       TEXT,                             -- the instruction a run is handling; state is 'snoozed' meanwhile
  custom        TEXT NOT NULL DEFAULT '[]',       -- JSON [{id:'c1', label, instruction}], up to 3, looked up by id, never put into callback_data
  tg_message_id INTEGER,
  msg_state     TEXT NOT NULL DEFAULT 'none' CHECK (msg_state IN ('none', 'sending', 'live', 'collapsed', 'gone')),
  rendered_hash TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS items_short ON items (user_id, short);
CREATE INDEX IF NOT EXISTS items_state_expiry ON items (state, expires_at);

-- Every transition and every press, append only.
CREATE TABLE IF NOT EXISTS item_log (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  item_id    TEXT NOT NULL,
  at         INTEGER NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  by         TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS item_log_item ON item_log (user_id, item_id, at);

-- The queue. P0 your text, P1 your buttons, P2 jobs. The runner leases one event at a time and heartbeats it.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  item_id      TEXT NOT NULL DEFAULT '',          -- '' for a plain session message
  action       TEXT NOT NULL DEFAULT 'ask',       -- ask | reply | c1..c3
  created_at   INTEGER NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  session_id   TEXT,
  text         TEXT,
  files        TEXT,                              -- JSON [{file_id, kind, size, name, mime}]
  reply_to     INTEGER,                           -- the Telegram message id the answer replies to
  status       TEXT NOT NULL DEFAULT 'queued',    -- queued | running | done | failed | stopped | expired
  attempts     INTEGER NOT NULL DEFAULT 0,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  leased_until INTEGER,
  lease_id     TEXT,                              -- pull returns it; beat and ack must present it
  acked_at     INTEGER
);
CREATE INDEX IF NOT EXISTS events_queue ON events (status, priority, created_at);

-- Sessions: a conversation is a row pointing at a Claude session id.
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,             -- 12 hex chars
  user_id           INTEGER NOT NULL,
  title             TEXT NOT NULL,
  claude_session_id TEXT,                         -- set by the runner after the first turn
  cwd               TEXT,
  workflow          TEXT NOT NULL DEFAULT 'chat', -- 'live' for a terminal session attached through the channel
  status            TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'archived')),
  created_at        INTEGER NOT NULL,
  last_active       INTEGER NOT NULL,
  day_key           TEXT                          -- 'YYYY-MM-DD' for the day's main session, NULL for /new ones
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_main_day ON sessions (user_id, day_key) WHERE day_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_user_active ON sessions (user_id, last_active);

-- Every bot message of a session, and your messages in it: a reply resolves the session here.
CREATE TABLE IF NOT EXISTS session_msgs (
  user_id       INTEGER NOT NULL,
  tg_message_id INTEGER NOT NULL,
  session_id    TEXT NOT NULL,
  PRIMARY KEY (user_id, tg_message_id)
);
-- /new and /sessions switch the target; valid while day_key is today.
CREATE TABLE IF NOT EXISTS session_target (user_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, day_key TEXT NOT NULL);

-- Live switches and small keyed state. Switches live here, not in wrangler.toml, so a deploy from any checkout cannot flip them.
-- Keys in use: pause:until, pause:ack, LIVE_SEEN:<session>, key:<name> (a living message edited in place).
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
