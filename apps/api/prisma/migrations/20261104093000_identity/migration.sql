CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email citext NOT NULL,
  password_hash varchar(256) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  email_verified_at timestamptz(6),
  security_version integer NOT NULL DEFAULT 0,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT users_status CHECK (status IN ('pending', 'active', 'disabled')),
  CONSTRAINT users_verified CHECK (status <> 'active' OR email_verified_at IS NOT NULL),
  CONSTRAINT users_email_length CHECK (length(email::text) BETWEEN 3 AND 254),
  CONSTRAINT users_security_version CHECK (security_version >= 0)
);
CREATE UNIQUE INDEX users_email_key ON users(email);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  token_hash char(64) NOT NULL,
  csrf_hash char(64) NOT NULL,
  security_version integer NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  last_seen_at timestamptz(6) NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  revoked_at timestamptz(6),
  ip varchar(45) NOT NULL,
  user_agent varchar(512) NOT NULL,
  CONSTRAINT user_sessions_hashes CHECK (token_hash ~ '^[a-f0-9]{64}$' AND csrf_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT user_sessions_security_version CHECK (security_version >= 0),
  CONSTRAINT user_sessions_times CHECK (last_seen_at >= created_at AND expires_at > last_seen_at AND expires_at <= created_at + INTERVAL '7 days')
);
CREATE UNIQUE INDEX user_sessions_token_hash_key ON user_sessions(token_hash);
CREATE INDEX user_sessions_user_id_revoked_at_idx ON user_sessions(user_id, revoked_at);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions(expires_at);

CREATE TABLE identity_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  purpose varchar(16) NOT NULL,
  token_hash char(64) NOT NULL,
  security_version integer NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  used_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT identity_tokens_purpose CHECK (purpose IN ('verify', 'reset')),
  CONSTRAINT identity_tokens_hash CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT identity_tokens_security_version CHECK (security_version >= 0),
  CONSTRAINT identity_tokens_times CHECK (expires_at > created_at AND expires_at <= created_at + CASE WHEN purpose = 'verify' THEN INTERVAL '24 hours' ELSE INTERVAL '30 minutes' END)
);
CREATE UNIQUE INDEX identity_tokens_token_hash_key ON identity_tokens(token_hash);
CREATE INDEX identity_tokens_user_id_purpose_idx ON identity_tokens(user_id, purpose);
CREATE INDEX identity_tokens_expires_at_idx ON identity_tokens(expires_at);
