-- Durable per-node action queue (PLAN M1.4a2). The action message is stored encrypted: it can
-- carry environment values. Delivery is at-least-once; the agent journal makes it idempotent.
CREATE TABLE agent_actions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  kind varchar(64) NOT NULL CHECK (kind ~ '^[a-zA-Z]{1,64}$'),
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  payload_enc bytea NOT NULL,
  lease_epoch integer NOT NULL CHECK (lease_epoch >= 1),
  deadline timestamptz(6) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('queued','pending','running','succeeded','failed',
    'cancelled','compensating','compensated','expired')),
  step varchar(64) NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  result jsonb,
  error varchar(256),
  requested_by varchar(128),
  created_at timestamptz(6) NOT NULL,
  updated_at timestamptz(6) NOT NULL,
  completed_at timestamptz(6),
  CONSTRAINT agent_actions_organization_id_node_id_fkey FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT agent_actions_node_id_idempotency_key_key UNIQUE (node_id, idempotency_key)
);
CREATE INDEX agent_actions_organization_id_node_id_state_idx ON agent_actions(organization_id, node_id, state);

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON agent_actions
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
