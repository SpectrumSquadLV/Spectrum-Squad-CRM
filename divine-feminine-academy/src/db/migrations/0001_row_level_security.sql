-- Row-level security: the backstop.
--
-- Authorization lives in the data access layer, where every query function
-- takes an actor context. This layer exists so that a mistake THERE does not
-- become a breach: if application code ever runs a query it should not have,
-- Postgres still refuses.
--
-- The app connects as a role that is subject to these policies. Migrations and
-- trusted server work (Stripe webhooks, automations) connect as the owner or
-- service role, which bypasses them.
--
-- auth.uid() is Supabase's current authenticated user id.
--
-- Supabase defines it. A plain Postgres - Railway, Neon, a local container,
-- anything self-hosted - does not, and every policy below is written against
-- it. A LANGUAGE sql function body is validated when it is created, so on
-- such a database this migration used to fail on its very first statement and
-- take the whole deploy with it.
--
-- So define it here when it is absent, with the same body Supabase uses: the
-- subject claim of the request's JWT, or NULL when there is no request. NULL
-- is the safe direction - every policy below compares against it, so an
-- unauthenticated connection matches nobody's rows rather than everybody's.
--
-- Guarded both ways, because on Supabase this schema is not ours to touch.

DO $shim$
BEGIN
  IF to_regnamespace('auth') IS NULL THEN
    CREATE SCHEMA auth;
  END IF;

  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $fn$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $fn$;
  END IF;
END
$shim$;

-- A woman's own contact row, resolved once per policy evaluation.
CREATE OR REPLACE FUNCTION public.current_contact_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.contacts WHERE user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN ('coach', 'admin', 'owner')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND role IN ('admin', 'owner')
  );
$$;

-- ---------------------------------------------------------------------------
-- Her own records: she reads and writes her own, staff may read.
-- ---------------------------------------------------------------------------
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contacts_self_select" ON "contacts"
  FOR SELECT USING (user_id = auth.uid() OR public.is_staff());

CREATE POLICY "contacts_self_update" ON "contacts"
  FOR UPDATE USING (user_id = auth.uid() OR public.is_admin());

ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_self_all" ON "profiles"
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "profiles_staff_select" ON "profiles"
  FOR SELECT USING (public.is_staff());

-- ---------------------------------------------------------------------------
-- THE JOURNAL.
--
-- Bodies are ciphertext, so even a policy failure here leaks nothing readable.
-- The policy still narrows who may fetch the rows at all: she may, and a user
-- she has an unrevoked share with may. Staff are NOT on this list, by design -
-- admin surfaces read the journal_metadata view instead.
-- ---------------------------------------------------------------------------
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "journal_entries_owner_all" ON "journal_entries"
  FOR ALL USING (contact_id = public.current_contact_id())
  WITH CHECK (contact_id = public.current_contact_id());

-- These two helpers exist to break a recursion: a policy on journal_entries
-- that reads journal_shares, plus a policy on journal_shares that reads
-- journal_entries, makes Postgres refuse both with "infinite recursion
-- detected in policy". SECURITY DEFINER runs as the table owner, which
-- bypasses RLS, so the cycle never forms.
CREATE OR REPLACE FUNCTION public.entry_is_shared_with_me(entry uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.journal_shares s
    WHERE s.entry_id = entry
      AND s.shared_with_user_id = auth.uid()
      AND s.revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.owns_journal_entry(entry uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.journal_entries e
    WHERE e.id = entry
      AND e.contact_id = public.current_contact_id()
  );
$$;

CREATE POLICY "journal_entries_shared_select" ON "journal_entries"
  FOR SELECT USING (public.entry_is_shared_with_me(id));

ALTER TABLE "journal_shares" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "journal_shares_owner_all" ON "journal_shares"
  FOR ALL USING (public.owns_journal_entry(entry_id))
  WITH CHECK (public.owns_journal_entry(entry_id));

CREATE POLICY "journal_shares_recipient_select" ON "journal_shares"
  FOR SELECT USING (shared_with_user_id = auth.uid());

-- The wrapped data keys. Nobody reads these through the anon role, ever;
-- decryption happens in trusted server code using the service role.
ALTER TABLE "contact_encryption_keys" ENABLE ROW LEVEL SECURITY;

-- Metadata without the words. This is what admin screens are allowed to read.
-- security_invoker = false on purpose: the journal_entries policies shut staff
-- out of the table entirely, which is right for bodies and wrong for
-- engagement. This view is the one sanctioned staff path, and it cannot leak
-- words because body_encrypted is not among its columns.
CREATE OR REPLACE VIEW public.journal_metadata
WITH (security_invoker = false) AS
  SELECT
    id,
    contact_id,
    title,
    area,
    source,
    program_id,
    lesson_id,
    word_count,
    created_at,
    updated_at
  FROM public.journal_entries
  WHERE contact_id = public.current_contact_id() OR public.is_staff();

COMMENT ON VIEW public.journal_metadata IS
  'Journal engagement WITHOUT body_encrypted. Admin surfaces read this view; nothing here reveals what she wrote.';

-- ---------------------------------------------------------------------------
-- The HER system: hers to write, staff may read (counts and patterns, which
-- are the coaching signal). Raw reflections live in the journal, not here.
-- ---------------------------------------------------------------------------
ALTER TABLE "her_patterns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "her_patterns_owner_all" ON "her_patterns"
  FOR ALL USING (contact_id = public.current_contact_id())
  WITH CHECK (contact_id = public.current_contact_id());
CREATE POLICY "her_patterns_staff_select" ON "her_patterns"
  FOR SELECT USING (public.is_staff());

ALTER TABLE "her_choices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "her_choices_owner_all" ON "her_choices"
  FOR ALL USING (contact_id = public.current_contact_id())
  WITH CHECK (contact_id = public.current_contact_id());
CREATE POLICY "her_choices_staff_select" ON "her_choices"
  FOR SELECT USING (public.is_staff());

-- RETURN sessions are written on her worst days. Hers alone.
ALTER TABLE "return_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "return_sessions_owner_all" ON "return_sessions"
  FOR ALL USING (contact_id = public.current_contact_id())
  WITH CHECK (contact_id = public.current_contact_id());

ALTER TABLE "her_codes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "her_codes_owner_all" ON "her_codes"
  FOR ALL USING (contact_id = public.current_contact_id())
  WITH CHECK (contact_id = public.current_contact_id());
CREATE POLICY "her_codes_staff_select" ON "her_codes"
  FOR SELECT USING (public.is_staff());

-- ---------------------------------------------------------------------------
-- Progress.
-- ---------------------------------------------------------------------------
ALTER TABLE "enrollments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "enrollments_owner_select" ON "enrollments"
  FOR SELECT USING (contact_id = public.current_contact_id() OR public.is_staff());

ALTER TABLE "lesson_progress" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lesson_progress_owner_all" ON "lesson_progress"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.id = lesson_progress.enrollment_id
        AND e.contact_id = public.current_contact_id()
    )
  );
CREATE POLICY "lesson_progress_staff_select" ON "lesson_progress"
  FOR SELECT USING (public.is_staff());

-- Sensitive block responses are ciphertext, same as journal bodies.
ALTER TABLE "block_responses" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "block_responses_owner_all" ON "block_responses"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.enrollments e
      WHERE e.id = block_responses.enrollment_id
        AND e.contact_id = public.current_contact_id()
    )
  );
CREATE POLICY "block_responses_staff_select" ON "block_responses"
  FOR SELECT USING (public.is_staff() AND is_sensitive = false);

-- ---------------------------------------------------------------------------
-- Commerce: she sees her own money, admins see all of it.
-- ---------------------------------------------------------------------------
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders_owner_select" ON "orders"
  FOR SELECT USING (contact_id = public.current_contact_id() OR public.is_admin());

ALTER TABLE "certificates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "certificates_owner_select" ON "certificates"
  FOR SELECT USING (contact_id = public.current_contact_id() OR public.is_staff());

-- ---------------------------------------------------------------------------
-- Staff-only surfaces.
-- ---------------------------------------------------------------------------
ALTER TABLE "crm_notes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "crm_notes_staff_all" ON "crm_notes"
  FOR ALL USING (public.is_staff());

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
-- Deliberately no policy: the audit log is never readable through the anon
-- role. Only the owner role, which bypasses RLS, can read it.

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_roles_self_select" ON "user_roles"
  FOR SELECT USING (user_id = auth.uid() OR public.is_staff());

-- ---------------------------------------------------------------------------
-- Published programs are public; drafts are not.
-- ---------------------------------------------------------------------------
ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "programs_published_select" ON "programs"
  FOR SELECT USING (status = 'published' OR public.is_staff());
