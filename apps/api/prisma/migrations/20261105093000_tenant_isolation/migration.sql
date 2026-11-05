-- Refuse an invalid pre-existing state; never invent an owner during migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM organizations o WHERE NOT EXISTS (
    SELECT 1 FROM memberships m WHERE m.organization_id=o.id AND m.org_role='owner'
  )) THEN
    RAISE EXCEPTION 'Organization must retain an owner.' USING ERRCODE='23514', CONSTRAINT='organizations_owner_required';
  END IF;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON organizations
  USING (id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (id = nullif(current_setting('app.org_id',true),'')::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON memberships
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON projects
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON environments
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

ALTER TABLE role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON role_bindings
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

-- Invoker privileges, qualified tables and a fixed search path; no security-definer bypass.
CREATE FUNCTION guard_organization_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  affected uuid[];
  organization uuid;
  previous_context text := coalesce(current_setting('app.org_id',true),'');
BEGIN
  IF TG_TABLE_NAME='organizations' THEN
    affected := CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.id] ELSE ARRAY[OLD.id,NEW.id] END;
  ELSE
    affected := CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.organization_id]
      WHEN TG_OP='DELETE' THEN ARRAY[OLD.organization_id]
      ELSE ARRAY[OLD.organization_id,NEW.organization_id] END;
  END IF;
  FOR organization IN SELECT DISTINCT value FROM unnest(affected) AS ids(value) ORDER BY value LOOP
    -- Deferred checks must still see their stored tenant if the caller changes context.
    PERFORM set_config('app.org_id',organization::text,true);
    IF TG_WHEN='BEFORE' THEN
      -- A write lock also prevents stale-snapshot write skew at REPEATABLE READ.
      UPDATE public.organizations SET updated_at=updated_at WHERE id=organization;
    ELSIF EXISTS (SELECT 1 FROM public.organizations WHERE id=organization)
      AND NOT EXISTS (SELECT 1 FROM public.memberships WHERE organization_id=organization AND org_role='owner') THEN
      RAISE EXCEPTION 'Organization must retain an owner.' USING ERRCODE='23514', CONSTRAINT='organizations_owner_required';
    END IF;
  END LOOP;
  PERFORM set_config('app.org_id',previous_context,true);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER memberships_serialize_ownership BEFORE INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION guard_organization_owner();
CREATE CONSTRAINT TRIGGER memberships_require_owner AFTER INSERT OR UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_organization_owner();
CREATE CONSTRAINT TRIGGER organizations_require_owner AFTER INSERT OR UPDATE ON organizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_organization_owner();
