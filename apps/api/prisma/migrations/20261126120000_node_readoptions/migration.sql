-- A certificate the installation CA signed for a node, presented to the gateway but absent from the
-- registry (#487): after a restore from a backup older than the node's last renewal. One row per
-- node, its latest presentation. An administrator's confirmation registers the certificate and
-- deletes the row; the row goes with its node.
CREATE TABLE node_readoptions (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  serial varchar(64) NOT NULL,
  not_before timestamptz(6) NOT NULL,
  not_after timestamptz(6) NOT NULL,
  first_seen_at timestamptz(6) NOT NULL,
  last_seen_at timestamptz(6) NOT NULL,
  PRIMARY KEY (organization_id, node_id),
  CONSTRAINT node_readoptions_node_fkey FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);

ALTER TABLE node_readoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_readoptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON node_readoptions
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
