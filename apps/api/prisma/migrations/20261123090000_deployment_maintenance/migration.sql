-- Entering and leaving maintenance are deployments that only switch the routes of the running
-- release (ADR 0025, issue #256), part of the plan fixed when the deployment is queued, like a
-- stop. Null for every other deployment; a deployment cannot both stop and change maintenance.
ALTER TABLE deployments ADD COLUMN plan_maintenance varchar(8);
ALTER TABLE deployments ADD CONSTRAINT deployments_plan_maintenance_check
  CHECK (plan_maintenance IS NULL OR plan_maintenance IN ('enter', 'leave'));
ALTER TABLE deployments ADD CONSTRAINT deployments_plan_maintenance_not_stop_check
  CHECK (plan_maintenance IS NULL OR NOT plan_stop);
