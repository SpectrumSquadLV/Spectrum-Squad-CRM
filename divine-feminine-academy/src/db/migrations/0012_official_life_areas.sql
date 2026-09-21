-- The four official life areas.
--
-- HERSELF / RELATIONSHIPS / MONEY / SUCCESS replace an earlier
-- self / love / life / wealth set across the whole platform.
--
-- The values are RENAMED rather than dropped and recreated, so every existing
-- row keeps its meaning and no foreign key or check constraint has to be
-- rebuilt. Postgres rewrites nothing here; this is a catalogue change.
--
-- Two of the four are a straight rename. The other two are not a clean
-- one-to-one match: the old `wealth` carried both money and career, and the
-- old `life` was a general catch-all rather than success. The enum rename
-- below preserves whatever each row already meant; the quiz's per-option
-- weights are re-audited separately, in code, so that new answers measure the
-- area they now name.
-- Guarded, so re-running is a no-op rather than an error. RENAME VALUE fails
-- outright if the old label is gone, which would take a whole deploy down for
-- the crime of having already worked.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'area' AND e.enumlabel = 'self'
  ) THEN
    ALTER TYPE "area" RENAME VALUE 'self' TO 'herself';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'area' AND e.enumlabel = 'love'
  ) THEN
    ALTER TYPE "area" RENAME VALUE 'love' TO 'relationships';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'area' AND e.enumlabel = 'wealth'
  ) THEN
    ALTER TYPE "area" RENAME VALUE 'wealth' TO 'money';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'area' AND e.enumlabel = 'life'
  ) THEN
    ALTER TYPE "area" RENAME VALUE 'life' TO 'success';
  END IF;
END
$$;
