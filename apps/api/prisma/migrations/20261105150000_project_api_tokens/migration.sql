-- Project-bound API tokens (PLAN M2.3e). The creator stays the owner whose live authority and
-- security version bound every use; the optional project limits where the token can act and
-- removes it together with the project.
ALTER TABLE api_tokens ADD COLUMN organization_id uuid, ADD COLUMN project_id uuid;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_project_pair_check
  CHECK ((organization_id IS NULL) = (project_id IS NULL));
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_organization_id_project_id_fkey
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)
  ON DELETE CASCADE ON UPDATE RESTRICT;
CREATE INDEX api_tokens_organization_id_project_id_id_idx ON api_tokens(organization_id, project_id, id);
