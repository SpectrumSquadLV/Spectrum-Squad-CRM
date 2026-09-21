# Deploying the Divine Feminine

Written to be followed in order. Every step says what breaks if you skip it.

**Before anything:** decide where the app will live. Vercel and Railway are
both wired up — `vercel.json` and `railway.toml` are in the repository — so
this is a choice, not a migration.

| | Vercel | Railway |
| --- | --- | --- |
| Next.js support | Native | Good |
| Hourly job | Built in (`vercel.json`) | GitHub Actions (see §8) |
| You already use it | No | Yes |

**Recommendation: Vercel**, because the hourly job is one line of config rather
than a separate service. Railway is a perfectly good answer if consolidating
billing matters more.

---

## 1. Supabase

1. Create a project. Choose a region near most of the women using it — every
   page render talks to this database.
2. From **Project Settings → Database**, copy a connection string.

**Which connection string.** Supabase gives you a direct one and a pooled one.

- **Serverless (Vercel): use the pooled string** (host contains `pooler`, port
  usually `6543`). A serverless function opens a connection per invocation and
  a direct connection will exhaust the limit under any real traffic.
- **A long-running server (Railway): the direct string is fine.**

The app detects a pooled URL and disables prepared statements automatically —
the pooler does not support them, and without that every query would fail.
`npm run verify:db-url` covers the detection.

3. From **Project Settings → API**, copy the project URL and the **anon** key.

> You do **not** need the service role key. Nothing in this codebase reads it.
> If you set it anyway, preflight will tell you to remove it — a key that can
> bypass every security policy should not sit in an environment for no reason.

## 2. Generate your own secrets

```bash
# Journals are encrypted with this. Losing it loses every entry, permanently.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Protects the hourly job endpoint.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Back up `JOURNAL_MASTER_KEY` somewhere that is not this deployment.** A
password manager is fine. If you lose it, every journal entry every woman has
ever written becomes permanently unreadable. That is the design working, not
failing — but it is unforgiving.

## 3. Apply the migrations

Run these from your machine, against the **direct** connection string (not the
pooler — migrations create objects and want a real session):

```bash
cd divine-feminine-academy
npm ci
DATABASE_URL="postgresql://...direct..." npm run db:migrate
```

Seven migrations apply, in order:

| | What it does |
| --- | --- |
| `0000_thick_magus` | 51 tables, 25 enums |
| `0001_row_level_security` | Policies, and the `journal_metadata` view |
| `0002_source_block_provenance` | Idempotency columns for side effects |
| `0003_one_certificate_per_program` | Stops a race issuing two certificates |
| `0004_quiz_archetypes` | Archetype quizzes: `assessments.kind`, the result's archetype |
| `0005_email_opt_out` | `contacts.email_opted_out_at`, so a lead can unsubscribe |
| `0006_writing` | The `articles` table: essays, episodes, scheduling, opt-ins |

| `0007_live_cohorts` | Cohorts, waitlists, cohort-paced enrollments |
| `0008_mirror_sessions` | Mirror Gaze sessions and retiring ME |
| `0009_site_images` | The photographs on the public site |

`0001` defines policies that call `auth.uid()`. **Supabase provides it.** On a
plain Postgres it does not, so `0001` now defines it — the JWT subject claim,
or NULL when there is no request — and does nothing when it is already there.
That makes the schema installable on Railway, Neon or a local container.
Preflight reports which one you have.

## 4. Seed

Order matters: the offers seed needs the CRM stages the challenge seed creates.

```bash
DATABASE_URL="postgresql://...direct..." npm run seed:challenge
DATABASE_URL="postgresql://...direct..." npm run seed:assessment
DATABASE_URL="postgresql://...direct..." npm run seed:offers
DATABASE_URL="postgresql://...direct..." npm run seed:quiz
DATABASE_URL="postgresql://...direct..." npm run seed:sequences
DATABASE_URL="postgresql://...direct..." npm run seed:writing
```

This creates **ME VS HER with placeholder prompts**, a placeholder
assessment, **ME VS HER priced at $11 and ACTIVE**, **two draft offers for the
full Divine Feminine course**, and **the archetype quiz**.
ME VS HER is purchasable the moment the keys are in. The full course is not,
until you activate one of its offers in `/admin/offers`.

The quiz and its four email sequences are the one part seeded with real copy
rather than placeholders — but they are a first draft. Read them aloud before
you send anybody to them.

`seed:sequences` creates sixteen automation rules and switches them **on**. A
sequence nobody remembered to activate is the most common way a launch
quietly collects addresses and mails none of them.

`seed:writing` adds three example pieces **as drafts**. They are written in
somebody else's voice and nothing machine-written should appear under your name
without you having read it, so they stay invisible until you press Publish.
Edit them or delete them.

## 5. Environment variables

Set these on the host. `.env.example` documents every one.

**Required:**

```
DATABASE_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
JOURNAL_MASTER_KEY
NEXT_PUBLIC_SITE_URL      # https, no trailing slash
RESEND_API_KEY            # without it, sign-in links are silently discarded
EMAIL_FROM
CRON_SECRET               # without it, no reminder ever sends
```

**Once you are selling:**

```
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

## 5b. Photographs

The site is plain without them. Seven slots, listed at `/admin/images` with
what to shoot in each; or drop files into `assets/photographs/` named after
the slot, with a `.txt` beside each holding its description, and
`npm run seed:images` puts them in on every deploy.

Location data and orientation flags are stripped on the way in. See
`## Photographs` in the README.

## 6. Make yourself an admin

Sign up through the site first, so the account exists. Then:

```sql
-- Your user id is in Supabase under Authentication → Users.
INSERT INTO user_roles (user_id, role) VALUES ('<your-auth-user-id>', 'owner');
```

Until you do this, `/admin` returns 404 to you as well. That is the role gate
working.

## 7. Stripe

1. **Developers → Webhooks → Add endpoint**:
   `https://<your-domain>/api/webhooks/payments`
2. Send these events:
   `checkout.session.completed`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `charge.refunded`,
   `customer.subscription.deleted`
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

**Test with a real card before you announce anything.** Checkout and fulfilment
are covered by `verify:fulfilment`, but that runs against a fake provider. It
has never spoken to Stripe.

## 8. The hourly job

**Vercel:** already configured in `vercel.json`. Vercel sends `CRON_SECRET` as
a Bearer token automatically.

**Railway:** no built-in scheduler, and this is now handled by GitHub Actions
instead — `.github/workflows/divine-feminine-cron.yml`, hourly at minute 17.

**Order matters, and the first step is easy to miss.**

1. **Merge the workflow to the default branch.** GitHub registers `schedule`
   and `workflow_dispatch` from the default branch only. On a feature branch
   the workflow is not scheduled, does not appear in the Actions tab, and
   cannot be run by hand — the API returns 404 for it. Until it is on `main`
   there is no scheduler at all.
2. **Add the repository secret.** `DIVINE_FEMININE_CRON_SECRET`, under
   Settings → Secrets and variables → Actions, whose value is the
   `CRON_SECRET` variable on the `divine-feminine-web` service in Railway.
   Until it is set, every run fails loudly with a message saying exactly
   that, which is the right way round — a scheduler that silently does
   nothing is the failure this replaced.
3. **Run it once by hand** from the Actions tab (`workflow_dispatch`). That
   triggers the first podcast sync without waiting for the hour, and confirms
   the secret before an unattended run depends on it.

**A Railway cron service was tried first and did not work.** The container
started on schedule and produced no output, no request and no error — the job
never ran once. If somebody tries that route again, prove it by looking at
the WEB service's request count in the minute the cron fired, not at the cron
container's own status: a container that starts and exits silently reports
SUCCESS.

Two things about GitHub's scheduler worth knowing: runs can land five to
fifteen minutes late when the shared runners are busy, and GitHub disables
scheduled workflows in a repository with no commits for 60 days. Everything
the endpoint does is idempotent and driven by timestamps, so lateness costs
only a delay.

**Without a scheduler, no reminder, nudge or abandoned-checkout email ever
sends, and the podcast never syncs.** The challenge depends on that daily
email.

## 9. Preflight

```bash
npm run preflight
```

Run it against the deployed environment. It checks every variable, the shape of
the master key, that the database connects, that the migrations are applied,
and that `auth.uid()` exists. **It exits non-zero on any error**, so it can gate
a deploy.

Then confirm the deployment is actually up:

```bash
curl -s https://<your-domain>/api/health     # {"status":"ok"}
```

## 9b. The noindex switch

`SITE_NOINDEX=1` keeps the site out of search results: `robots.txt` disallows
everything, the sitemap is emptied, every page carries a noindex meta tag, and
every response carries `X-Robots-Tag: noindex, nofollow`. Four, because a
crawler that ignores one may respect another — and because the meta tag alone
cannot cover a page that was prerendered at build time.

All four are decided per request, so setting or removing the variable takes
effect on the next request without a rebuild. **Removing it is how the site
goes live.**

```bash
npm run build && npm run verify:noindex
```

That starts the built server twice, with the variable and without it, and
checks both directions. The off state matters as much as the on state.

## 10. Before you announce it

- [ ] `grep -rn "<Placeholder" app src` returns nothing
- [ ] The seven days have real prompts, not `[PLACEHOLDER COPY]`
- [ ] The assessment questions are real
- [ ] The quiz questions, the four results and the twenty sequence emails sound
      like you, not like a draft somebody else wrote
      (`src/features/quiz/questions.ts`, `src/features/quiz/archetypes.ts`,
      `src/features/quiz/sequences.ts`)
- [ ] You have sent yourself one archetype sequence end to end and clicked the
      unsubscribe link in it
- [ ] The three seeded example pieces are edited into your voice, or deleted
- [ ] `/writing/rss.xml` opens in a feed reader, and in a podcast app if you
      have published an episode
- [ ] **The crisis phone numbers are confirmed correct** — they are US lines in
      `src/features/care/CrisisResources.tsx`, and they appear wherever a woman
      writes something heavy
- [ ] The legal pages have been read by a lawyer
- [ ] You have bought ME VS HER yourself, with a real card, at $11
- [ ] The full course has a price you have decided on, and its offer is active
- [ ] `JOURNAL_MASTER_KEY` is backed up somewhere other than the host
- [ ] `npm run preflight` reports no errors

---

## A note on row-level security

The app connects with `DATABASE_URL`, which on Supabase is the `postgres`
owner — and **an owner bypasses row-level security.** So for the app's own
queries, the real gate is the actor context in `src/db/queries`, which is
enforced by the type system and covered by `verify:permissions` and
`verify:crm-privacy`.

The RLS policies are a backstop for anything that reaches the database another
way: the Supabase client, a future direct integration, a mistake.

**To put the app itself behind RLS too** — worth doing eventually — create a
restricted role and connect as that, keeping the owner for migrations:

```sql
CREATE ROLE dfa_app LOGIN PASSWORD '<a strong password>';
GRANT USAGE ON SCHEMA public, auth TO dfa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dfa_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dfa_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO dfa_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dfa_app;
```

Then point `DATABASE_URL` at `dfa_app` and keep the owner string for
`npm run db:migrate`. `npm run verify:rls` exercises exactly this setup.

This is **not** done by default because it needs the request's user id to reach
Postgres (`request.jwt.claim.sub`), which is a change to how every query is
issued. It is the right next step for the security posture, and it is not
required to launch.

## Rollback

Migrations are forward-only. To undo a deploy, redeploy the previous commit —
none of the four migrations drop data, so an older build runs against a newer
schema without loss.
