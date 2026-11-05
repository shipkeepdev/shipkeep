-- Environment secrets (SPEC 9, PLAN M3.7). Values are encrypted with the environment's DEK and
-- never returned by the API; only names, versions and change metadata are readable.
CREATE TABLE secrets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name varchar(128) NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,127}$'),
  value_enc bytea NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  updated_by varchar(128),
  created_at timestamptz(6) NOT NULL,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT secrets_environment_fkey FOREIGN KEY (organization_id, project_id, environment_id)
    REFERENCES environments(organization_id, project_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT secrets_environment_id_name_key UNIQUE (environment_id, name)
);
CREATE INDEX secrets_organization_id_environment_id_idx ON secrets(organization_id, environment_id);

ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON secrets
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
