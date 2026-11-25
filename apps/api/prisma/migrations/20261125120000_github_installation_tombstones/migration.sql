-- A removed installation stays as a tombstone (#475). GitHub never brings an installation back:
-- installing the App again makes a new one. So no later delivery for it changes anything, even
-- one older than the removal, and even once its delivery records are forgotten.
ALTER TABLE github_installations ADD COLUMN deleted_at timestamptz(6);
