-- Every tenant-scoped table carries its organization (SPEC 4, ADR 0015). Certificates inherit it
-- from their node; the composite key makes a certificate of another tenant's node impossible.
ALTER TABLE node_certificates ADD COLUMN organization_id uuid;
UPDATE node_certificates c SET organization_id = n.organization_id FROM nodes n WHERE n.id = c.node_id;
ALTER TABLE node_certificates ALTER COLUMN organization_id SET NOT NULL;

CREATE UNIQUE INDEX nodes_organization_id_id_key ON nodes(organization_id, id);
ALTER TABLE node_certificates DROP CONSTRAINT node_certificates_node_id_fkey;
ALTER TABLE node_certificates ADD CONSTRAINT node_certificates_organization_id_node_id_fkey
  FOREIGN KEY (organization_id, node_id) REFERENCES nodes(organization_id, id)
  ON DELETE CASCADE ON UPDATE RESTRICT;
DROP INDEX node_certificates_node_id_idx;
CREATE INDEX node_certificates_organization_id_node_id_idx ON node_certificates(organization_id, node_id);
