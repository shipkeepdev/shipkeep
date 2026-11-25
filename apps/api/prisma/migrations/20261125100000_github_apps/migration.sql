-- The GitHub App an organization creates through GitHub's manifest flow (ADR 0031): one per
-- organization. GitHub hands back its private key, webhook secret and client secret; they are
-- encrypted with the organization's data key and bound to the App's identifier, and the API never
-- returns them.
CREATE TABLE github_apps (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  app_id bigint NOT NULL UNIQUE CHECK (app_id > 0),
  slug varchar(64) NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  name varchar(34) NOT NULL CHECK (char_length(name) >= 1),
  -- The GitHub account the App belongs to.
  owner_login varchar(39) NOT NULL CHECK (owner_login ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
  client_id varchar(64) NOT NULL CHECK (client_id ~ '^[A-Za-z0-9.]{1,64}$'),
  private_key_enc bytea NOT NULL,
  webhook_secret_enc bytea NOT NULL,
  client_secret_enc bytea NOT NULL,
  created_by varchar(128),
  created_at timestamptz(6) NOT NULL
);

ALTER TABLE github_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON github_apps
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

-- One manifest flow under way per organization: the state GitHub must bring back, hashed, the
-- owner who started it, and until when it can be completed.
CREATE TABLE github_app_flows (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  state_hash bytea NOT NULL CHECK (octet_length(state_hash) = 32),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  expires_at timestamptz(6) NOT NULL
);

ALTER TABLE github_app_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_app_flows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON github_app_flows
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
