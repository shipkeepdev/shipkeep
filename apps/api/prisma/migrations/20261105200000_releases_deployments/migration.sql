-- Releases and deployments (SPEC 4 and 5.1, PLAN M3.4b2).
-- A release is an immutable snapshot of an application's configuration and image. Only its image
-- digest may be recorded later, once, when the pipeline resolves the tag (M3.4c).
CREATE TABLE releases (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  image varchar(512) NOT NULL,
  image_digest varchar(71) CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 131072),
  config_sha char(64) NOT NULL CHECK (config_sha ~ '^[0-9a-f]{64}$'),
  created_by varchar(128),
  created_at timestamptz(6) NOT NULL,
  CONSTRAINT releases_application_fkey FOREIGN KEY (organization_id, application_id)
    REFERENCES applications(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT releases_application_id_number_key UNIQUE (application_id, number),
  CONSTRAINT releases_organization_id_id_key UNIQUE (organization_id, id)
);

CREATE FUNCTION releases_write_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.image_digest IS NOT NULL OR ROW(NEW.id, NEW.organization_id, NEW.application_id,
      NEW.number, NEW.image, NEW.config, NEW.config_sha, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.application_id, OLD.number, OLD.image,
      OLD.config, OLD.config_sha, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'releases are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER releases_write_once BEFORE UPDATE ON releases
  FOR EACH ROW EXECUTE FUNCTION releases_write_once();

CREATE TABLE deployments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  release_id uuid NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('queued','building','built','releasing','scheduling',
    'starting','health_checking','switching','draining','succeeded','failed','cancelled','rolled_back')),
  plan_build boolean NOT NULL,
  plan_release boolean NOT NULL,
  trigger varchar(16) NOT NULL CHECK (trigger IN ('manual','webhook','rollback')),
  actor_id varchar(128),
  error varchar(512),
  started_at timestamptz(6) NOT NULL,
  finished_at timestamptz(6),
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT deployments_application_fkey FOREIGN KEY (organization_id, application_id)
    REFERENCES applications(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT deployments_release_fkey FOREIGN KEY (organization_id, release_id)
    REFERENCES releases(organization_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT deployments_finished_check CHECK (
    (state IN ('succeeded','failed','cancelled','rolled_back')) = (finished_at IS NOT NULL))
);
-- SPEC 4: one active deployment per application, enforced by the database.
CREATE UNIQUE INDEX deployments_one_active_key ON deployments(application_id)
  WHERE state NOT IN ('succeeded','failed','cancelled','rolled_back');
CREATE INDEX deployments_application_id_started_at_idx ON deployments(application_id, started_at DESC);
CREATE INDEX deployments_release_id_idx ON deployments(release_id);

ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON releases
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON deployments
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
