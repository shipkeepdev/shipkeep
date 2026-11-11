-- Public addresses an administrator declares for a node (SPEC 5.2, PLAN M3.6b1). The domain check
-- compares DNS answers with them. The API validates and canonicalizes every value; the database
-- bounds the list and refuses nulls so no other writer can store an unbounded one. The table keeps
-- its tenant row security and runtime grants.
ALTER TABLE nodes ADD COLUMN public_addresses varchar(45)[] NOT NULL DEFAULT '{}';
ALTER TABLE nodes ADD CONSTRAINT nodes_public_addresses_bounded CHECK (
  cardinality(public_addresses) <= 8
  AND array_position(public_addresses, NULL) IS NULL
);
