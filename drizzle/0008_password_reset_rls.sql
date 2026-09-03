-- password_resets holds the hashes of live reset tokens.
--
-- Only the auth context touches it — a reset happens before any session
-- exists — so there is no rep or customer clause. A signed-in rep has no
-- reason to read this table, and a customer certainly doesn't.

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS password_resets_auth_only ON password_resets;

CREATE POLICY password_resets_auth_only ON password_resets
  USING (app_is_admin() OR app_is_auth())
  WITH CHECK (app_is_admin() OR app_is_auth());
