CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(64) NOT NULL CHECK (length(btrim(name)) > 0),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes jsonb NOT NULL CHECK (CASE WHEN jsonb_typeof(scopes) = 'array'
    THEN jsonb_array_length(scopes) BETWEEN 1 AND 32 ELSE false END),
  security_version integer NOT NULL CHECK (security_version >= 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK (expires_at >= created_at + interval '1 minute' AND expires_at <= created_at + interval '90 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at)
);
CREATE INDEX api_tokens_user_id_id_idx ON api_tokens(user_id, id);
CREATE INDEX api_tokens_user_id_security_version_expires_at_idx ON api_tokens(user_id, security_version, expires_at);
