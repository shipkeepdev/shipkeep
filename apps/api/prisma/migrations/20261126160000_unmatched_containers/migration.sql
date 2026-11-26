-- The managed containers a node's agent reported that match no replica placed on it (#501), as its
-- last state report said: after a restore, the containers of deployments the backup does not know.
-- Replaced when the set changes; the rows go with their node.
CREATE TABLE unmatched_containers (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  name varchar(63) NOT NULL,
  container_id char(64) NOT NULL,
  state varchar(16) NOT NULL,
  observed_at timestamptz(6) NOT NULL,
  PRIMARY KEY (node_id, name),
  CONSTRAINT unmatched_containers_node_fkey FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX unmatched_containers_organization_id_node_id_idx
  ON unmatched_containers(organization_id, node_id);

ALTER TABLE unmatched_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_containers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON unmatched_containers
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
