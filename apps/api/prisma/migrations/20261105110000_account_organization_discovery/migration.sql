-- A verified account can discover its own organizations before choosing a tenant.
-- SELECT-only policies never authorize tenant writes, other memberships or project contents.
CREATE POLICY account_discovery ON memberships FOR SELECT USING (
  nullif(current_setting('app.org_id',true),'') IS NULL
  AND user_id = nullif(current_setting('app.user_id',true),'')::uuid
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.id=memberships.user_id
    AND u.status='active' AND u.email_verified_at IS NOT NULL)
);

CREATE POLICY account_discovery ON organizations FOR SELECT USING (
  nullif(current_setting('app.org_id',true),'') IS NULL
  AND id IN (SELECT organization_id FROM public.memberships
    WHERE user_id = nullif(current_setting('app.user_id',true),'')::uuid)
);
