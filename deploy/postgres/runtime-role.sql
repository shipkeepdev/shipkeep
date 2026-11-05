-- Run transactionally, after migrations, with the dedicated Shipkeep database administrator.
-- This NOLOGIN group never owns tenant tables. Application logins inherit its limited grants.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shipkeep_runtime') THEN
    CREATE ROLE shipkeep_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='shipkeep_runtime' AND
    (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relowner=r.oid)
      OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND n.nspowner=r.oid))) THEN
    RAISE EXCEPTION 'Unsafe existing Shipkeep runtime role.';
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO shipkeep_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM shipkeep_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  users,user_sessions,identity_tokens,identity_throttles,identity_replays,user_mfa,recovery_codes,api_tokens,
  organizations,memberships,projects,environments,role_bindings,
  nodes,node_certificates,join_tokens,secrets TO shipkeep_runtime;
-- Single-use state only moves forward; rows are never deleted by the API.
GRANT SELECT,INSERT,UPDATE ON confirmation_tokens,agent_actions TO shipkeep_runtime;
-- Applications and their deployments are removed only with their environment (cascade).
GRANT SELECT,INSERT,UPDATE ON applications,deployments,allocations TO shipkeep_runtime;
-- Releases are immutable: the image digest is the only column ever written after insert (once).
GRANT SELECT,INSERT ON releases TO shipkeep_runtime;
GRANT UPDATE (image_digest) ON releases TO shipkeep_runtime;
-- Append-only from the API: audit history, and wrapped key material that is never rewritten
-- (SPEC 9: rotation inserts new rows). Losing a DEK row would make its secrets unrecoverable.
GRANT SELECT,INSERT ON audit_events,data_encryption_keys,installation_keys TO shipkeep_runtime;

-- pg-boss administers only its dedicated schema. Transfer existing queue objects explicitly;
-- never REASSIGN OWNED globally, which could transfer tenant tables to the runtime role.
CREATE SCHEMA IF NOT EXISTS shipkeep_jobs AUTHORIZATION shipkeep_runtime;
ALTER SCHEMA shipkeep_jobs OWNER TO shipkeep_runtime;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.oid,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='shipkeep_jobs' AND c.relkind IN ('r','p','S','v','m') LOOP
    EXECUTE format('ALTER %s %s OWNER TO shipkeep_runtime',
      CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, item.oid::regclass);
  END LOOP;
  FOR item IN SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='shipkeep_jobs' AND t.typtype IN ('e','d') LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO shipkeep_runtime',item.oid::regtype);
  END LOOP;
  FOR item IN SELECT p.oid,p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='shipkeep_jobs' AND p.prokind IN ('f','p') LOOP
    EXECUTE format('ALTER %s %s OWNER TO shipkeep_runtime',
      CASE item.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,item.oid::regprocedure);
  END LOOP;
END $$;
