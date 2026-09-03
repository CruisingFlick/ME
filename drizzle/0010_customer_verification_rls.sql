-- customer_verifications holds the hashes of live sign-in codes.
--
-- Only the auth context touches it: a code is checked before any session
-- exists. No rep or customer clause — neither has a reason to read it.

ALTER TABLE customer_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_verifications FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_verifications_auth_only ON customer_verifications;

CREATE POLICY customer_verifications_auth_only ON customer_verifications
  USING (app_is_admin() OR app_is_auth())
  WITH CHECK (app_is_admin() OR app_is_auth());
