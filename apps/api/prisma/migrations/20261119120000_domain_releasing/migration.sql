-- A domain removed from an application's configuration stays reserved while a release of that
-- application with placed replicas still lists it: its route may still serve it (#302). Such a
-- reservation is "releasing" from this time, and is deleted once nothing placed serves it.
ALTER TABLE domains ADD COLUMN releasing_at timestamptz(6);
