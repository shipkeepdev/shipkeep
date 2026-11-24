-- Agent upgrades across an organization's servers, one at a time (ADR 0028, section 2). One row per
-- rollout; at most one runs per organization. The rows go with the organization's fleet.
CREATE TABLE agent_upgrades (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  version varchar(64) NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  state varchar(16) NOT NULL CHECK (state IN ('running','succeeded','failed')),
  node_ids uuid[] NOT NULL CHECK (cardinality(node_ids) BETWEEN 1 AND 1000),
  position integer NOT NULL CHECK (position >= 0 AND position <= cardinality(node_ids)),
  action_id uuid,
  turn_started_at timestamptz(6) NOT NULL,
  failure_node_id uuid,
  failure_reason varchar(32) CHECK (failure_reason IN ('node_unavailable','node_busy',
    'release_unavailable','action_failed','rolled_back','not_confirmed')),
  failure_action_reason varchar(64) CHECK (failure_action_reason ~ '^[a-z_]{1,64}$'),
  requested_by varchar(128),
  created_at timestamptz(6) NOT NULL,
  updated_at timestamptz(6) NOT NULL,
  completed_at timestamptz(6),
  CONSTRAINT agent_upgrades_failure_check CHECK ((state = 'failed') = (failure_reason IS NOT NULL)),
  CONSTRAINT agent_upgrades_completed_check CHECK ((state = 'running') = (completed_at IS NULL))
);
CREATE UNIQUE INDEX agent_upgrades_one_running_idx ON agent_upgrades(organization_id)
  WHERE state = 'running';
CREATE INDEX agent_upgrades_organization_id_created_at_idx
  ON agent_upgrades(organization_id, created_at DESC);

ALTER TABLE agent_upgrades ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_upgrades FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON agent_upgrades
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
