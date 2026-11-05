-- Storage foundation only. Row policies and ownership guards land before tenant HTTP access.
CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name varchar(80) NOT NULL CHECK (name = btrim(name) AND length(name) > 0 AND name !~ '[[:cntrl:]]'),
  slug varchar(40) NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL
);
CREATE UNIQUE INDEX organizations_slug_key ON organizations(slug);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  org_role varchar(16) NOT NULL DEFAULT 'member' CHECK (org_role IN ('owner', 'admin', 'member')),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL
);
CREATE UNIQUE INDEX memberships_organization_id_user_id_key ON memberships(organization_id,user_id);
CREATE UNIQUE INDEX memberships_organization_id_id_key ON memberships(organization_id,id);
CREATE INDEX memberships_user_id_idx ON memberships(user_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  name varchar(80) NOT NULL CHECK (name = btrim(name) AND length(name) > 0 AND name !~ '[[:cntrl:]]'),
  slug varchar(40) NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  git_write_mode varchar(16) NOT NULL DEFAULT 'pull_request' CHECK (git_write_mode IN ('commit','pull_request')),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL
);
CREATE UNIQUE INDEX projects_organization_id_slug_key ON projects(organization_id,slug);
CREATE UNIQUE INDEX projects_organization_id_id_key ON projects(organization_id,id);

CREATE TABLE environments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  project_id uuid NOT NULL,
  name varchar(40) NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,39}$'),
  kind varchar(16) NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','preview')),
  failover_policy varchar(32) NOT NULL DEFAULT 'none' CHECK (failover_policy IN ('none','restore-from-backup')),
  protected boolean NOT NULL DEFAULT true,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX environments_project_id_name_key ON environments(project_id,name);
CREATE UNIQUE INDEX environments_organization_id_project_id_id_key ON environments(organization_id,project_id,id);

CREATE TABLE role_bindings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE CASCADE,
  membership_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid,
  role varchar(16) NOT NULL CHECK (role IN ('admin','developer','viewer')),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  FOREIGN KEY (organization_id,membership_id) REFERENCES memberships(organization_id,id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (organization_id,project_id) REFERENCES projects(organization_id,id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (organization_id,project_id,environment_id) REFERENCES environments(organization_id,project_id,id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX role_bindings_membership_id_project_id_environment_id_key ON role_bindings(membership_id,project_id,environment_id) NULLS NOT DISTINCT;
CREATE INDEX role_bindings_organization_id_project_id_environment_id_idx ON role_bindings(organization_id,project_id,environment_id);
