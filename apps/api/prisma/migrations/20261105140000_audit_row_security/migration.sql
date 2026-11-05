-- Audit events join the forced tenant row security of SPEC 4 (PLAN M2.3g2).
-- Reads: a tenant sees only its own events. System and account events (organization_id null)
-- are not readable by the runtime role. Appends stay allowed from every command transaction,
-- but a tenant context can only append events of its own organization or of no organization.
-- No UPDATE or DELETE policy exists: with forced row security both are denied even if granted.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_events FOR SELECT USING (
  organization_id = nullif(current_setting('app.org_id',true),'')::uuid
);
CREATE POLICY append ON audit_events FOR INSERT WITH CHECK (
  organization_id IS NULL
  OR nullif(current_setting('app.org_id',true),'') IS NULL
  OR organization_id = nullif(current_setting('app.org_id',true),'')::uuid
);
