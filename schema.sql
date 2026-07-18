-- Agent Alpaca D1 schema. Apply with:
--   wrangler d1 execute agentalpaca --file=schema.sql              (local)
--   wrangler d1 execute agentalpaca --remote --file=schema.sql     (production)
--
-- The database stores accounts, hashed bridge tokens, and a registry of terminal
-- sessions (metadata only). Live terminal bytes flow through the Durable Object
-- and are never written here.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- random uuid
  -- Google accounts store the verified email (also the key used to link methods).
  -- Passkey-only accounts have no real email, so they store a synthetic unique
  -- placeholder ("<id>@passkey.local") that never collides with a real address.
  email       TEXT UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL           -- unix seconds
);

-- A "bridge" is one paired home machine. It authenticates over HTTP/WS with a
-- bearer token; only the token's SHA-256 hash is stored (raw token lives on the
-- home machine in ~/.agentalpaca/config.json).
CREATE TABLE IF NOT EXISTS bridges (
  id          TEXT PRIMARY KEY,          -- random uuid
  user_id     TEXT NOT NULL,
  token_hash  TEXT UNIQUE NOT NULL,      -- sha256b64u(raw bridge token)
  label       TEXT,                      -- e.g. hostname
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One row per terminal the bridge is wrapping. `bridge_online` is flipped by the
-- Durable Object as the bridge socket connects/disconnects, so the web session
-- list can show live/offline without polling the home machine.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,        -- random uuid, also the DO name
  user_id       TEXT NOT NULL,
  bridge_id     TEXT,
  label         TEXT,                    -- shown in the session list
  cmd           TEXT,                    -- the wrapped command line
  cols          INTEGER,
  rows          INTEGER,
  created_at    INTEGER NOT NULL,        -- unix seconds
  last_seen     INTEGER NOT NULL,        -- unix seconds, updated on (dis)connect
  bridge_online INTEGER NOT NULL DEFAULT 0,
  closed        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, last_seen);

-- Passkeys (WebAuthn credentials). One row per registered authenticator. The
-- public key + signature counter are all the server needs to verify sign-ins;
-- no shared secret is ever stored.
CREATE TABLE IF NOT EXISTS credentials (
  id          TEXT PRIMARY KEY,          -- base64url credential id
  user_id     TEXT NOT NULL,
  public_key  TEXT NOT NULL,             -- base64url COSE public key
  counter     INTEGER NOT NULL DEFAULT 0,
  transports  TEXT,                      -- json array, e.g. ["internal","hybrid"]
  label       TEXT,                      -- optional friendly name
  created_at  INTEGER NOT NULL,
  last_used   INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials (user_id);
