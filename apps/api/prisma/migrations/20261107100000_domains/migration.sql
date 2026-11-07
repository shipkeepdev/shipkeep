-- Domains claimed by applications (SPEC 4, PLAN M3.6a): a hostname belongs to one application per
-- organization, otherwise two applications would overwrite each other's route. Rows are synced
-- from the configuration whenever it is saved, so the configuration stays the source of truth.
CREATE TABLE domains (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  hostname varchar(253) NOT NULL,
  created_at timestamptz(6) NOT NULL,
  CONSTRAINT domains_application_fkey FOREIGN KEY (organization_id, application_id)
    REFERENCES applications(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT domains_organization_id_hostname_key UNIQUE (organization_id, hostname)
);
CREATE INDEX domains_application_id_idx ON domains(application_id);

ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON domains
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
