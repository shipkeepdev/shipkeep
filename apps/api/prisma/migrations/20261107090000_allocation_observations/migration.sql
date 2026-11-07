-- What the agent last observed for an allocation (SPEC 3.5, PLAN M1.6b2). Kept apart from
-- `allocations`, whose `state` is the scheduler's reservation: an observation never frees or
-- takes capacity.
ALTER TABLE allocations ADD CONSTRAINT allocations_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE allocation_observations (
  allocation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  container_id char(64) CHECK (container_id ~ '^[a-f0-9]{64}$'),
  state varchar(16) NOT NULL CHECK (state IN ('created','running','paused','restarting','exited','dead','missing')),
  observed_at timestamptz(6) NOT NULL,
  CONSTRAINT allocation_observations_organization_id_allocation_id_key UNIQUE (organization_id, allocation_id),
  CONSTRAINT allocation_observations_allocation_fkey FOREIGN KEY (organization_id, allocation_id)
    REFERENCES allocations(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);

ALTER TABLE allocation_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON allocation_observations
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
