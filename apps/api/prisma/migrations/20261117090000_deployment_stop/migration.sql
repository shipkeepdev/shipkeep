-- A stop is a deployment that starts nothing and removes the serving replicas of its application
-- (issue #256). It is part of the plan fixed when the deployment is queued, like build and
-- release. Every deployment stored before this migration started replicas.
ALTER TABLE deployments ADD COLUMN plan_stop boolean NOT NULL DEFAULT false;
