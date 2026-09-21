-- What she allows herself to want, from Day 5 of ME VS. HER.
--
-- Four rows per woman, one per life area, written on the day HER first
-- appears and read back to her on Days 5, 6 and 7. They outlive the challenge
-- because every later program reads from them: a woman should not be asked
-- what she wants twice.
--
-- The text is encrypted with her own key, exactly like a journal body. These
-- are the most tender sentences in the product.
CREATE TABLE IF NOT EXISTS "her_desires" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "area" "area" NOT NULL,
  "text_encrypted" text NOT NULL,
  "source_enrollment_id" uuid REFERENCES "enrollments"("id"),
  "source_block_id" uuid REFERENCES "lesson_blocks"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "her_desires_contact_idx"
  ON "her_desires" ("contact_id");

-- Day 5 asks each area once, so re-saving updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "her_desires_area_key"
  ON "her_desires" ("contact_id", "source_enrollment_id", "area");

-- Hers alone, like RETURN sessions and journal bodies were: she reads and
-- writes her own rows and there is NO staff select policy, because the text
-- is what she allows herself to want and nobody needs to read it but her.
-- Admin surfaces get counts from the row existing, never the sentence.
ALTER TABLE "her_desires" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "her_desires_owner_all" ON "her_desires"
  FOR ALL USING (contact_id = public.current_contact_id())
  WITH CHECK (contact_id = public.current_contact_id());
