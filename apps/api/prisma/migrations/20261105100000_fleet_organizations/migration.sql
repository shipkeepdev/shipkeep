-- Existing installations must reconcile orphan fleet records explicitly before upgrading.
-- Do not create organizations/owners, reassign servers or delete enrollment history here.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM nodes n WHERE NOT EXISTS (
    SELECT 1 FROM organizations o WHERE o.id=n.organization_id
  )) OR EXISTS (SELECT 1 FROM join_tokens t WHERE NOT EXISTS (
    SELECT 1 FROM organizations o WHERE o.id=t.organization_id
  )) THEN
    RAISE EXCEPTION 'Fleet records reference missing organizations.' USING ERRCODE='23503';
  END IF;
END $$;

ALTER TABLE nodes ADD CONSTRAINT nodes_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE join_tokens ADD CONSTRAINT join_tokens_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
