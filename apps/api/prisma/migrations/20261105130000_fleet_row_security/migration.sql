-- Fleet tables join the forced tenant row security of SPEC 4 (ADR 0015).
ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON nodes
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

ALTER TABLE node_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON node_certificates
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

ALTER TABLE join_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE join_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON join_tokens
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);

-- Enrollment starts from a join token alone. Outside any tenant, the transaction-local hash of
-- the presented token exposes that single row for reading; every write then runs in the token's
-- organization. No other fleet row is visible in this context.
CREATE POLICY join_token_lookup ON join_tokens FOR SELECT USING (
  nullif(current_setting('app.org_id',true),'') IS NULL
  AND token_hash = nullif(current_setting('app.join_token_hash',true),'')::char(64)
);
