-- Agent actions name the deployment that requested them (issue #263), so an application can list
-- the typed actions run for it. Actions issued outside a deployment keep both columns null, and so
-- do actions queued before this migration. Deleting an application deletes its deployments; their
-- actions stay in the node's history with both columns cleared.
ALTER TABLE deployments
  ADD CONSTRAINT deployments_organization_id_application_id_id_key
  UNIQUE (organization_id, application_id, id);

ALTER TABLE agent_actions
  ADD COLUMN application_id uuid,
  ADD COLUMN deployment_id uuid,
  ADD CONSTRAINT agent_actions_origin_check CHECK ((application_id IS NULL) = (deployment_id IS NULL)),
  -- The deployment must belong to the same organization and application as the action.
  ADD CONSTRAINT agent_actions_deployment_fkey
    FOREIGN KEY (organization_id, application_id, deployment_id)
    REFERENCES deployments(organization_id, application_id, id)
    ON DELETE SET NULL (application_id, deployment_id) ON UPDATE RESTRICT;

-- An application's actions, newest first (ids are UUIDv7).
CREATE INDEX agent_actions_application_id_id_idx ON agent_actions(application_id, id DESC)
  WHERE application_id IS NOT NULL;
-- Clearing the link when a deployment is deleted.
CREATE INDEX agent_actions_deployment_id_idx ON agent_actions(deployment_id)
  WHERE deployment_id IS NOT NULL;
