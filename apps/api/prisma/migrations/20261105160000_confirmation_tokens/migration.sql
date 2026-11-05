-- Issued confirmation tokens (SPEC 3.6). The signed token itself is never stored: only its id,
-- binding and single-use state. Rows stay after expiry as part of the security history.
CREATE TABLE confirmation_tokens (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  action varchar(64) NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  target varchar(128) NOT NULL CHECK (target ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  issued_at timestamptz(6) NOT NULL,
  expires_at timestamptz(6) NOT NULL CHECK (expires_at > issued_at),
  used_at timestamptz(6) CHECK (used_at IS NULL OR used_at >= issued_at)
);
CREATE INDEX confirmation_tokens_organization_id_issued_at_idx
  ON confirmation_tokens(organization_id, issued_at);

ALTER TABLE confirmation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmation_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON confirmation_tokens
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
