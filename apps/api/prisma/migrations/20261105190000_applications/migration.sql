-- Applications (SPEC 4, PLAN M3.4b). The configuration is the validated shipkeep.yml document as
-- canonical JSON; it holds secret names only, never values. Image sources only until M3.1/M3.8.
CREATE TABLE applications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  name varchar(40) NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
  source varchar(16) NOT NULL CHECK (source IN ('image')),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 131072),
  config_sha char(64) NOT NULL CHECK (config_sha ~ '^[0-9a-f]{64}$'),
  created_by varchar(128),
  created_at timestamptz(6) NOT NULL,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT applications_environment_fkey FOREIGN KEY (organization_id, project_id, environment_id)
    REFERENCES environments(organization_id, project_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT applications_environment_id_name_key UNIQUE (environment_id, name),
  -- Target of the composite foreign keys of releases and deployments (M3.4b2).
  CONSTRAINT applications_organization_id_id_key UNIQUE (organization_id, id)
);
CREATE INDEX applications_organization_id_environment_id_idx ON applications(organization_id, environment_id);

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON applications
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
