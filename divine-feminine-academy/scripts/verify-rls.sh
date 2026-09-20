#!/usr/bin/env bash
#
# Proves the row-level security policies actually isolate one woman's journal
# from another's, and that staff can see engagement but never words.
#
# Builds a throwaway database from the migrations, runs the checks, drops it.
#
#   PGHOST=... PGPORT=... PGUSER=... ./scripts/verify-rls.sh
#
# Needs a Postgres the user can CREATE DATABASE on. Supabase provides
# auth.uid(); this stubs it so the same policies can be exercised locally.
set -euo pipefail

DB="${RLS_TEST_DB:-dfa_rls_check}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

cleanup() { psql -q -c "DROP DATABASE IF EXISTS $DB;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1))
  fi
}

cleanup
psql -q -c "CREATE DATABASE $DB;"
psql -q -d "$DB" -c "CREATE SCHEMA auth; CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;"

for f in "$DIR"/src/db/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done

psql -q -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO app_user;

INSERT INTO contacts (id, email, first_name, user_id) VALUES
  ('11111111-1111-1111-1111-111111111111','maya@example.test','Maya','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('22222222-2222-2222-2222-222222222222','renee@example.test','Renee','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('33333333-3333-3333-3333-333333333333','coach@example.test','Coach','cccccccc-cccc-cccc-cccc-cccccccccccc');
INSERT INTO user_roles (user_id, role) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','coach');
INSERT INTO journal_entries (id, contact_id, body_encrypted, word_count) VALUES
  ('aaaa1111-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','CIPHERTEXT-MAYA',12),
  ('bbbb2222-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','CIPHERTEXT-RENEE',30);
SQL

as() { psql -qAt -d "$DB" -c "SET ROLE app_user; SELECT set_config('request.jwt.claim.sub','$1',false); $2" 2>&1 | tail -n +2; }
MAYA=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
RENEE=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
COACH=cccccccc-cccc-cccc-cccc-cccccccccccc

echo "row-level security:"

check "a member reads only her own journal body" \
  "CIPHERTEXT-MAYA" \
  "$(as $MAYA "SELECT coalesce(string_agg(body_encrypted,','),'NONE') FROM journal_entries;")"

check "another member cannot see it" \
  "CIPHERTEXT-RENEE" \
  "$(as $RENEE "SELECT coalesce(string_agg(body_encrypted,','),'NONE') FROM journal_entries;")"

check "a COACH can read no journal body at all" \
  "NONE" \
  "$(as $COACH "SELECT coalesce(string_agg(body_encrypted,','),'NONE') FROM journal_entries;")"

check "a coach CAN read journal metadata" \
  "2 rows, 42 words" \
  "$(as $COACH "SELECT count(*)||' rows, '||coalesce(sum(word_count),0)||' words' FROM journal_metadata;")"

check "a member sees only her own metadata" \
  "1" \
  "$(as $MAYA "SELECT count(*) FROM journal_metadata;")"

check "the metadata view exposes no body column" \
  "0" \
  "$(psql -qAt -d "$DB" -c "SELECT count(*) FROM information_schema.columns WHERE table_name='journal_metadata' AND column_name='body_encrypted';")"

# Asserted on the outcome, not on the error text: what matters is that no row
# lands, and stderr ordering is not something to hang a security check on.
as $MAYA "INSERT INTO journal_entries (contact_id, body_encrypted) VALUES ('22222222-2222-2222-2222-222222222222','HOSTILE');" >/dev/null 2>&1 || true
check "a member cannot write an entry as someone else" \
  "0" \
  "$(psql -qAt -d "$DB" -c "SELECT count(*) FROM journal_entries WHERE body_encrypted = 'HOSTILE';")"

check "a member sees only her own contact row" \
  "1" "$(as $MAYA "SELECT count(*) FROM contacts;")"

check "staff see every contact" \
  "3" "$(as $COACH "SELECT count(*) FROM contacts;")"

check "the audit log is unreadable through the app role" \
  "0" "$(as $COACH "SELECT count(*) FROM audit_log;")"

check "a member's RETURN sessions are hers alone" \
  "0" "$(as $COACH "SELECT count(*) FROM return_sessions;")"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "row-level security: $FAIL of $((PASS + FAIL)) checks FAILED"
  exit 1
fi
echo "row-level security: all $PASS checks passed"
