CREATE TABLE identity_replays (
  key_hash CHAR(64) PRIMARY KEY,
  ciphertext BYTEA NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT identity_replay_hash CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT identity_replay_size CHECK (octet_length(ciphertext) BETWEEN 30 AND 131072),
  CONSTRAINT identity_replay_lifetime CHECK (expires_at = created_at + INTERVAL '5 minutes')
);
CREATE INDEX identity_replays_expires_at_idx ON identity_replays(expires_at);
