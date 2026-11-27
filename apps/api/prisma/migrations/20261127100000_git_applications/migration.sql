-- Applications deployed from a GitHub repository (ADR 0031, SPEC 4): the installation of the
-- organization's App that reaches the repository, the repository as GitHub identifies it and as
-- it names it, the branch, the path of shipkeep.yml in it, and the commit that configuration was
-- read from. An image application has none.
ALTER TABLE applications DROP CONSTRAINT applications_source_check;
ALTER TABLE applications
  ADD COLUMN installation_id bigint CHECK (installation_id > 0),
  ADD COLUMN repository_id bigint CHECK (repository_id > 0),
  ADD COLUMN repository varchar(140),
  ADD COLUMN branch varchar(255),
  ADD COLUMN config_path varchar(255),
  ADD COLUMN commit_sha char(40) CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT applications_source_check CHECK (source IN ('image', 'git')),
  ADD CONSTRAINT applications_git_source_check CHECK (
    CASE WHEN source = 'git'
      THEN installation_id IS NOT NULL AND repository_id IS NOT NULL AND repository IS NOT NULL
        AND branch IS NOT NULL AND config_path IS NOT NULL AND commit_sha IS NOT NULL
      ELSE installation_id IS NULL AND repository_id IS NULL AND repository IS NULL
        AND branch IS NULL AND config_path IS NULL AND commit_sha IS NULL
    END);
-- A push names a repository and a branch: the applications it deploys are found by them.
CREATE INDEX applications_repository_branch_idx ON applications (organization_id, repository_id, branch)
  WHERE source = 'git';

-- The commit a Git application's release was read from (SPEC 4). Releases stay immutable.
ALTER TABLE releases ADD COLUMN commit_sha char(40) CHECK (commit_sha ~ '^[0-9a-f]{40}$');
CREATE OR REPLACE FUNCTION releases_write_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.image_digest IS NOT NULL OR ROW(NEW.id, NEW.organization_id, NEW.application_id,
      NEW.number, NEW.image, NEW.config, NEW.config_sha, NEW.commit_sha, NEW.created_by,
      NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.application_id, OLD.number, OLD.image,
      OLD.config, OLD.config_sha, OLD.commit_sha, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'releases are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
