-- Credentials an organization stores for a container registry (ADR 0019), so that its deployments
-- can pull private images. One row per registry host. The password is encrypted with the
-- organization's data key and bound to the host and the version; the API never returns it.
CREATE TABLE registry_credentials (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- Host and optional port as image references name it, lower case; `docker.io` for Docker Hub.
  server varchar(255) NOT NULL CHECK (server ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$'),
  username varchar(256) NOT NULL CHECK (char_length(username) >= 1),
  password_enc bytea NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  updated_by varchar(128),
  created_at timestamptz(6) NOT NULL,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT registry_credentials_organization_id_server_key UNIQUE (organization_id, server)
);

ALTER TABLE registry_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON registry_credentials
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
