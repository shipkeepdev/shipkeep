-- Allocations (SPEC 4, PLAN M3.4c4a): one replica of a release on a node, placed by the scheduler
-- before the pipeline starts it. `stopped` once its release stops serving or its deployment fails.
CREATE TABLE allocations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  release_id uuid NOT NULL,
  node_id uuid NOT NULL,
  replica integer NOT NULL CHECK (replica >= 0 AND replica < 1000),
  container varchar(63) NOT NULL CHECK (container ~ '^sk-[a-z0-9-]{1,60}$'),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  cpu_millis integer NOT NULL CHECK (cpu_millis >= 0),
  memory_bytes bigint NOT NULL CHECK (memory_bytes >= 0),
  state varchar(16) NOT NULL CHECK (state IN ('placed','stopped')),
  created_at timestamptz(6) NOT NULL,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT allocations_application_fkey FOREIGN KEY (organization_id, application_id)
    REFERENCES applications(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT allocations_release_fkey FOREIGN KEY (organization_id, release_id)
    REFERENCES releases(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT allocations_node_fkey FOREIGN KEY (organization_id, node_id)
    REFERENCES nodes(organization_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT allocations_release_id_replica_key UNIQUE (release_id, replica),
  CONSTRAINT allocations_node_id_container_key UNIQUE (node_id, container)
);
CREATE INDEX allocations_application_id_state_idx ON allocations(application_id, state);
CREATE INDEX allocations_organization_id_node_id_state_idx ON allocations(organization_id, node_id, state);

ALTER TABLE allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON allocations
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

-- The pipeline reads its actions by key prefix (`d:<deployment>:`).
CREATE INDEX agent_actions_organization_id_idempotency_key_idx
  ON agent_actions(organization_id, idempotency_key text_pattern_ops);
