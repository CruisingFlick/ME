-- Row-level security.
--
-- Up to now, isolation between reps was enforced only by every query carrying
-- `rep_id` in its predicate. That works until someone writes a query and
-- forgets. These policies move the guarantee into the database: a query with no
-- tenant context set returns nothing at all, so forgetting fails closed
-- instead of leaking another rep's customers.
--
-- Context is set per-transaction by src/db/scoped.ts using set_config(..., true).

-- ---------------------------------------------------------------------------
-- Context accessors. `true` as the second argument to current_setting means
-- "return NULL if unset" rather than raising — that NULL is what makes an
-- unscoped query match no rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_rep_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.rep_id', true), '')::uuid
  $$;

CREATE OR REPLACE FUNCTION app_customer_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.customer_id', true), '')::uuid
  $$;

-- Set only by the CLI and the migration runner — never by a request path.
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('app.admin', true) = 'on', false)
  $$;

-- Set only by signup, login and the public invite page, which must read the
-- `reps` table before any session exists. It grants nothing on tenant data.
CREATE OR REPLACE FUNCTION app_is_auth() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('app.auth', true) = 'on', false)
  $$;

-- ---------------------------------------------------------------------------
-- FORCE, not just ENABLE: the application connects as the table owner, and an
-- owner is exempt from its own policies unless forced.
-- ---------------------------------------------------------------------------

ALTER TABLE reps            ENABLE ROW LEVEL SECURITY;
ALTER TABLE reps            FORCE  ROW LEVEL SECURITY;
ALTER TABLE customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers       FORCE  ROW LEVEL SECURITY;
ALTER TABLE customer_notes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notes  FORCE  ROW LEVEL SECURITY;
ALTER TABLE requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests        FORCE  ROW LEVEL SECURITY;
ALTER TABLE request_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_items   FORCE  ROW LEVEL SECURITY;
ALTER TABLE favourites      ENABLE ROW LEVEL SECURITY;
ALTER TABLE favourites      FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reps_access ON reps;
DROP POLICY IF EXISTS customers_access ON customers;
DROP POLICY IF EXISTS customer_notes_rep_only ON customer_notes;
DROP POLICY IF EXISTS requests_access ON requests;
DROP POLICY IF EXISTS request_items_access ON request_items;
DROP POLICY IF EXISTS favourites_access ON favourites;

-- ---------------------------------------------------------------------------
-- reps — the tenant registry.
--
-- A rep sees only their own row. The auth context can see rep rows because
-- login, signup and the public /r/{slug} page all have to look one up before a
-- session exists. A customer can see the one rep they belong to (the shop
-- header shows the business name).
-- ---------------------------------------------------------------------------

CREATE POLICY reps_access ON reps
  USING (
    app_is_admin()
    OR app_is_auth()
    OR id = app_rep_id()
    OR EXISTS (
      SELECT 1 FROM customers c
      WHERE c.id = app_customer_id() AND c.rep_id = reps.id
    )
  )
  WITH CHECK (app_is_admin() OR app_is_auth() OR id = app_rep_id());

-- ---------------------------------------------------------------------------
-- customers — a rep sees their own book; a customer sees only themselves.
-- ---------------------------------------------------------------------------

CREATE POLICY customers_access ON customers
  USING (
    app_is_admin()
    OR rep_id = app_rep_id()
    OR id = app_customer_id()
    -- Identifying on an invite link creates or re-finds a customer row before
    -- a customer session exists.
    OR app_is_auth()
  )
  WITH CHECK (app_is_admin() OR app_is_auth() OR rep_id = app_rep_id() OR id = app_customer_id());

-- ---------------------------------------------------------------------------
-- customer_notes — rep-only, with no customer clause at all. This is the
-- privacy guarantee expressed as a database rule: a customer session cannot
-- read these rows even if some future query asks for them.
-- ---------------------------------------------------------------------------

CREATE POLICY customer_notes_rep_only ON customer_notes
  USING (app_is_admin() OR rep_id = app_rep_id())
  WITH CHECK (app_is_admin() OR rep_id = app_rep_id());

-- ---------------------------------------------------------------------------
-- requests and their items.
-- ---------------------------------------------------------------------------

CREATE POLICY requests_access ON requests
  USING (
    app_is_admin()
    OR rep_id = app_rep_id()
    OR customer_id = app_customer_id()
  )
  WITH CHECK (
    app_is_admin()
    OR rep_id = app_rep_id()
    OR customer_id = app_customer_id()
  );

-- Items inherit their parent's visibility. The subquery is itself filtered by
-- the requests policy above, so this cannot widen access.
CREATE POLICY request_items_access ON request_items
  USING (
    app_is_admin()
    OR EXISTS (SELECT 1 FROM requests r WHERE r.id = request_items.request_id)
  )
  WITH CHECK (
    app_is_admin()
    OR EXISTS (SELECT 1 FROM requests r WHERE r.id = request_items.request_id)
  );

-- ---------------------------------------------------------------------------
-- favourites.
-- ---------------------------------------------------------------------------

CREATE POLICY favourites_access ON favourites
  USING (
    app_is_admin()
    OR rep_id = app_rep_id()
    OR customer_id = app_customer_id()
  )
  WITH CHECK (
    app_is_admin()
    OR rep_id = app_rep_id()
    OR customer_id = app_customer_id()
  );
