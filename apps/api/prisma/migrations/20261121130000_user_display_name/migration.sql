-- An optional name the account shows instead of its address (issue #251). Never used to sign in.
-- The application keeps it to 1-64 printable characters; the column bounds what it may hold.
ALTER TABLE users ADD COLUMN display_name varchar(64);
ALTER TABLE users ADD CONSTRAINT users_display_name_check
  CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 64);
