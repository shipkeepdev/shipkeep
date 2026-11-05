CREATE TABLE user_mfa (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_ciphertext BYTEA,
  enabled_at TIMESTAMPTZ(6),
  last_counter BIGINT,
  pending_ciphertext BYTEA,
  pending_version INTEGER,
  pending_created_at TIMESTAMPTZ(6),
  pending_expires_at TIMESTAMPTZ(6),
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT mfa_active_fields CHECK (
    (active_ciphertext IS NULL AND enabled_at IS NULL AND last_counter IS NULL) OR
    (active_ciphertext IS NOT NULL AND enabled_at IS NOT NULL AND last_counter IS NOT NULL)
  ),
  CONSTRAINT mfa_counter CHECK (last_counter BETWEEN 0 AND 9007199254740991),
  CONSTRAINT mfa_ciphertext CHECK (octet_length(active_ciphertext) BETWEEN 30 AND 4096),
  CONSTRAINT mfa_pending_fields CHECK (
    (pending_ciphertext IS NULL AND pending_version IS NULL AND pending_created_at IS NULL AND pending_expires_at IS NULL) OR
    (pending_ciphertext IS NOT NULL AND pending_version IS NOT NULL AND pending_created_at IS NOT NULL AND pending_expires_at IS NOT NULL)
  ),
  CONSTRAINT mfa_pending_ciphertext CHECK (octet_length(pending_ciphertext) BETWEEN 30 AND 4096),
  CONSTRAINT mfa_pending_version CHECK (pending_version >= 0),
  CONSTRAINT mfa_pending_lifetime CHECK (pending_expires_at = pending_created_at + INTERVAL '10 minutes'),
  CONSTRAINT mfa_single_state CHECK (active_ciphertext IS NULL OR pending_ciphertext IS NULL)
);
CREATE TABLE recovery_codes (
  user_id UUID NOT NULL REFERENCES user_mfa(user_id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL,
  used_at TIMESTAMPTZ(6),
  PRIMARY KEY (user_id, code_hash),
  CONSTRAINT recovery_hash CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT recovery_consumed_time CHECK (used_at IS NULL OR used_at >= created_at)
);
