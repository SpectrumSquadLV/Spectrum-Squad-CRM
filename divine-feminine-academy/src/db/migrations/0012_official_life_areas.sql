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
ALTER TYPE "area" RENAME VALUE 'self' TO 'herself';
ALTER TYPE "area" RENAME VALUE 'love' TO 'relationships';
ALTER TYPE "area" RENAME VALUE 'wealth' TO 'money';
ALTER TYPE "area" RENAME VALUE 'life' TO 'success';
