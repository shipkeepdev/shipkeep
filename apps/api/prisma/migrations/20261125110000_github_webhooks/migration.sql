-- Webhook deliveries GitHub made to an organization's App (ADR 0031): each identifier is recorded
-- once, with what the delivery did, and kept 30 days, so that the same delivery again does nothing.
CREATE TABLE github_deliveries (
  delivery_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  event varchar(64) NOT NULL CHECK (event ~ '^[a-z_]{1,64}$'),
  received_at timestamptz(6) NOT NULL
);
CREATE INDEX github_deliveries_organization_id_received_at_idx
  ON github_deliveries(organization_id, received_at);

ALTER TABLE github_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON github_deliveries
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

-- Where an organization's App is installed, as GitHub reported it: the account, whether every
-- repository or a selection, and whether the installation is suspended.
CREATE TABLE github_installations (
  installation_id bigint PRIMARY KEY CHECK (installation_id > 0),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  account_login varchar(39) NOT NULL CHECK (account_login ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
  account_type varchar(16) NOT NULL CHECK (account_type IN ('User', 'Organization')),
  repository_selection varchar(8) NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  suspended_at timestamptz(6),
  created_at timestamptz(6) NOT NULL,
  updated_at timestamptz(6) NOT NULL
);
CREATE INDEX github_installations_organization_id_idx ON github_installations(organization_id);

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON github_installations
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
