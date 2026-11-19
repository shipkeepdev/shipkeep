-- Why an agent stopped a container itself (ADR 0022), as its state report says while the container
-- exists. Only reasons the control plane knows are stored.
ALTER TABLE allocation_observations
  ADD COLUMN stop_reason varchar(16) CHECK (stop_reason IN ('disk_limit'));
