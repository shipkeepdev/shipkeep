-- The certificate each node's Caddy serves for a domain (SPEC 3.5, PLAN M3.6b2), as its state
-- report last said. One row per domain and node, since every node holds its own certificate.
-- Rows go with the domain or the node.
CREATE UNIQUE INDEX domains_organization_id_id_key ON domains(organization_id, id);

CREATE TABLE domain_certificates (
  organization_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  node_id uuid NOT NULL,
  not_after timestamptz(6) NOT NULL,
  issuer varchar(64) NOT NULL,
  observed_at timestamptz(6) NOT NULL,
  PRIMARY KEY (domain_id, node_id),
  CONSTRAINT domain_certificates_domain_fkey FOREIGN KEY (organization_id, domain_id)
    REFERENCES domains(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT domain_certificates_node_fkey FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX domain_certificates_organization_id_node_id_idx
  ON domain_certificates(organization_id, node_id);

ALTER TABLE domain_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON domain_certificates
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
