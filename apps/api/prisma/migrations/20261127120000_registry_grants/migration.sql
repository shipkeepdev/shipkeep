-- Credentials for the installation's own registry (ADR 0030): each one lets an action push to,
-- or pull from, one application's repository until its deadline. Its secret, which clients send
-- as the password of basic auth, is random, and only its purpose-bound SHA-256 is kept; the
-- registry's token endpoint checks it and answers a five-minute token.
CREATE TABLE registry_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  secret_sha256 char(64) NOT NULL UNIQUE CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  -- Pull is always granted; a build's grant may push as well.
  push boolean NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  created_at timestamptz(6) NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX registry_grants_expires_at_idx ON registry_grants (organization_id, expires_at);

ALTER TABLE registry_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON registry_grants
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
