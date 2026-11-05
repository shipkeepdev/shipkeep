CREATE TABLE identity_throttles (
  id uuid PRIMARY KEY,
  key_hash char(64) NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  window_ends_at timestamptz(6) NOT NULL,
  next_allowed_at timestamptz(6) NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT identity_throttles_key_hash CHECK (key_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX identity_throttles_key_hash_key ON identity_throttles(key_hash);
CREATE INDEX identity_throttles_window_ends_at_idx ON identity_throttles(window_ends_at);
