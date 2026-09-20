# Divine Feminine Academy

A website: one Next.js app serving three faces on one domain.

- **Public site** — indexed marketing pages, where social traffic lands.
- **Member portal** (`/my-academy`) — where a woman actually spends her time.
- **Admin / CRM** (`/admin`) — behind a staff login.

Mobile-first. Most women arrive on a phone from Instagram.

**All six phases are built.** Foundation, public site and identity, the
challenge engine, the LMS/assessments/certificates, the CRM and commerce, and
automations, analytics and hardening.

**7 DAYS TO HER runs end to end**, a programme can be built in the admin
without a developer, the free assessment scores and compares pre/post, and
certificates are issued and publicly verifiable — all against placeholder
copy, because the real curriculum and the real instrument are not written yet.

**Checkout works** — against a fake provider in tests, and against Stripe once
keys are configured. Nothing is on sale yet: both Academy offers are seeded as
**drafts**, because the price and refund window are still your decision.

---

## What exists right now

| Area | Status |
| --- | --- |
| Next.js 16 + TypeScript + Tailwind v4 | Built, builds clean |
| Design tokens + primitives + patterns | Built |
| Living style guide (`/admin/design`) | Built — **start here** |
| Database schema (51 tables, 25 enums) | Built, migrations applied and tested |
| Permissions model + actor context | Built |
| Journal encryption | Built, verified (`npm run verify:crypto`) |
| Row-level security | Built, verified (`npm run verify:rls`) |

| Public site (10 pages, SEO, legal) | Built |
| Sign-up / sign-in by magic link | Built |
| Auth gate + session refresh (`proxy.ts`) | Built |
| Member portal shell + account page | Built |
| Crisis resources component | Built — **US resources need confirming** |
| Block registry — 14 types | Built |
| Drip pacing engine | Built, verified (`npm run verify:rls`) |
| Day runner + response persistence | Built, verified (`npm run verify:engine`) |
| HER profile · I CHOSE HER · RETURN | Built |
| Journal (encrypted) + composer | Built |
| HER Code + public share page | Built |
| Admin role gate (staff only) | Built, verified (`npm run verify:permissions`) |
| Admin program builder | Built |
| Assessment engine + pre/post | Built, verified (`npm run verify:scoring`) |
| **The archetype quiz** | Built, verified (`verify:archetypes`, `verify:quiz`, `verify:quiz-flow`) |
| Quiz result copy (the four) | **Real first-draft copy — read it aloud and make it yours** |
| Sitemap + robots | Built |
| Social share cards for the quiz | Built |
| Certificates + public verification | Built, verified (`verify:certificates`, `verify:issuance`) |
| 7 DAYS TO HER curriculum | **Placeholder copy only** |
| Assessment questions | **Placeholder, not a validated instrument** |
| Per-archetype email sequences | Built and written, verified (`verify:sequences`) |
| Unsubscribe that works without a login | Built, verified |
| PDF export of the HER Code | **Not built** — see below |
| Pricing, coupons, instalments, refunds | Built, verified (`verify:pricing`) |
| Payment provider + Stripe adapter | Built |
| Webhook signature verification | Built, verified (`verify:webhooks`) |
| Checkout + idempotent fulfilment | Built, verified (`verify:fulfilment`) |
| CRM: contacts, pipeline, notes, tags | Built, verified (`verify:crm-privacy`) |
| Admin offers, coupons, orders, refunds | Built |
| Academy pricing | **Draft offers — you decide** |
| Email provider + templates | Built, verified (`verify:reminders`) |
| Automation engine | Built, verified (`verify:automation`) |
| Day reminders in her timezone | Built, verified |
| Funnel dashboard | Built |
| Rate limiting | Built, verified (`verify:rate-limit`) |
| Security headers | Built |
| WCAG 2.2 AA | **19 pages, 0 violations** (`verify:a11y`) |
| Content-Security-Policy | **Not done** — see Security |
| Preflight check | Built, verified (`verify:preflight`) |
| Vercel + Railway config | Both, so hosting is not a blocker |
| Health endpoint (`/api/health`) | Built |
| Deployment runbook | [DEPLOY.md](./DEPLOY.md) |

## The quiz

`/quiz` — twelve questions, about ninety seconds, two form fields.

She answers, sees one of her own sentences read back to her, gives a first name
and an email, and lands on a result naming one of four protective modes:

| Mode | She is | Public page |
| --- | --- | --- |
| Fight | The Commander | `/quiz/the-commander` |
| Flight | The Escape Artist | `/quiz/the-escape-artist` |
| Freeze | The Watcher | `/quiz/the-watcher` |
| Sulk | The Quiet Storm | `/quiz/the-quiet-storm` |

Every one is framed as protection rather than a flaw, because that is both
truer and the thing she forwards to three friends.

**The words live in two files and nowhere else.** Change them there and the
whole site follows:

- `src/features/quiz/questions.ts` — the twelve questions and their weights
- `src/features/quiz/archetypes.ts` — the four results

**What it does behind the scenes.** She becomes one contact (never two — an
email that already exists is her coming back). She is tagged
`archetype-the-quiet-storm` or similar, so every page and email afterwards can
know which of the four she is. A `quiz.completed` event is written carrying
her archetype, which the automation engine can branch on directly:
`equals: { archetype: 'sulk' }`. A retake writes a second attempt rather than
overwriting the first, so how she moves over months is kept.

**Scoring happens on the server**, from the stored questions and their stored
weights. The browser computes the same thing for the preview, but that number
is decoration — if the client could name the archetype, a crafted request could
write any result it liked into her segmentation.

The four public pages are statically prerendered, indexable and carry their own
social cards, because that is how a shared result brings a stranger in.

## The four email sequences

Five emails over nine days, one set per archetype. Twenty in total, and they
are written.

The arc is the same for all four, and the order is deliberate:

| | Day | What it does |
| --- | --- | --- |
| 1 | 0 | Deliver. She just gave an email; she gets the whole read back immediately, with nothing asked of her. |
| 2 | 1 | Where this version of her came from. Compassion before cost, always. |
| 3 | 3 | What it costs. Honest and specific — she already knows, and being vague to seem kind is patronising. |
| 4 | 5 | One small move she can make today. A win before an ask. |
| 5 | 8 | The invitation, to something free. |

**Two ways in, one set of emails.**

1. She takes the quiz and is put into the sequence for her result.
2. She lands on an archetype page from a link a friend sent, recognises
   herself, and opts in directly — no quiz. She is tagged
   `archetype-self-identified` as well, because a woman who chose her own
   archetype and a woman the quiz chose for her are not the same person and
   the numbers should be able to tell them apart.

Both write one `archetype.assigned` event, which is what the sixteen rules
match on.

**Email one is sent in the request.** Steps 2 to 5 are automation rules on a
delay. The hourly job is the only other clock here, so routing the welcome
through it would make "check your inbox" false for up to an hour — exactly
while she is still looking.

**The words are in one file:** `src/features/quiz/sequences.ts`. No HTML, no
sending logic. Rewrite it and the emails change.

**Unsubscribing works without an account.** Most women in these sequences have
never logged in, so the link is a signed token rather than a session — one
click, done, and it only stops lifecycle mail. Her sign-in links and receipts
keep working.


## Deploying

**[DEPLOY.md](./DEPLOY.md) is the runbook.** Ordered steps, each saying what
breaks if you skip it. Vercel and Railway are both wired up — `vercel.json` and
`railway.toml` are in the repository — so the hosting decision is a choice
rather than a migration.

```bash
npm run preflight   # exits non-zero if this deployment is not ready
```

Preflight checks every variable, the shape of the master key, that the database
connects, that the migrations are applied, and that `auth.uid()` exists. It
exists because a half-configured deploy is worse than one that refuses to
start: **with no Resend key the app silently discards every sign-in link**, and
a woman is locked out of her own account with nothing to tell her why.

## Running it locally

```bash
cp .env.example .env.local   # then fill it in
npm install
npm run dev                  # http://localhost:3000
```

Look at **`/admin/design`** first. Every token and primitive renders there.

```bash
npm run typecheck      # tsc, strict
npm run build          # production build
npm run verify:crypto       # 8  journal encryption
npm run verify:permissions  # 20 who can see what
npm run verify:pacing       # 17 drip unlocking and timezones
npm run verify:scoring      # 14 assessment scoring and pre/post
npm run verify:certificates # 13 certificate eligibility rules
npm run verify:engine       # 12 the challenge engine (needs DATABASE_URL)
npm run verify:issuance     # 7  certificate issuance (needs DATABASE_URL)
npm run verify:pricing      # 28 money: coupons, instalments, refunds
npm run verify:webhooks     # 17 that forged webhooks are refused
npm run verify:fulfilment   # 14 that paying grants access exactly once
npm run verify:crm-privacy  # 8  that the CRM cannot read her journal
npm run verify:automation   # 26 that nobody is emailed twice, or not at all
npm run verify:contrast     # 29 that every colour clears WCAG AA
npm run verify:reminders    # 15 that a reminder lands in HER morning
npm run verify:rate-limit   # 7  that the magic-link endpoint cannot be hammered
npm run verify:preflight    # 22 that a broken deploy is refused
npm run verify:db-url       # 6  that a pooled Supabase URL is detected
npm run verify:archetypes   # 68 quiz scoring, ties, and that all four are reachable
npm run verify:quiz         # 36 the quiz end to end (needs DATABASE_URL)
npm run verify:sequences    # 87 the four email sequences (needs DATABASE_URL)
npm run verify:rls          # 11 that RLS really isolates members

# Needs the app running (npm run build && npm start):
BASE_URL=http://127.0.0.1:3000 npm run verify:a11y       # axe, 19 pages
BASE_URL=http://127.0.0.1:3000 npm run verify:quiz-flow  # the quiz in a real browser, on a phone

npm run seed:challenge  # seed 7 DAYS TO HER (placeholder curriculum)
npm run seed:assessment # seed the free assessment (placeholder questions)
npm run seed:offers     # seed the Academy and its DRAFT offers
npm run seed:quiz       # seed the archetype quiz (REAL copy, first draft)
npm run seed:sequences  # seed the 16 rules that send the archetype emails
npm run db:generate    # regenerate SQL after a schema change
npm run db:migrate     # apply migrations (needs DATABASE_URL)
```

`verify:engine` runs the real save path against a real database and proves that
a Day 2 answer is stored as ciphertext, that Day 1 creates her HER profile and
re-saving edits it rather than duplicating it, that Day 6 cannot be
double-counted by an edit, and that every registry definition still reads
correctly on the server.

`verify:pacing` covers the drip rules, including both daylight-saving
transitions and the case that matters most: a woman who starts at 11pm gets
Day 2 the next **morning**, not the next night.

`verify:rls` builds a throwaway database from the migrations, seeds two members
and a coach, and proves that neither member can read the other's journal and
that the coach can read neither — while still seeing engagement metadata. It
needs a Postgres you can `CREATE DATABASE` on (`PGHOST`/`PGPORT`/`PGUSER`).

The style guide at `/admin/design` sits behind the admin gate in production. In
development it opens without a login, so you can review design tokens before
Supabase is configured.

---

## The three decisions this foundation encodes

**1. Programs are data, not code.** A lesson is a list of typed blocks
(`src/blocks/registry.ts`). Each block type is one React component registered
by name; the content lives in the database as JSON.

- A new **program** needs *no code*. It is rows, assembled in the admin builder.
- A new **block type** is one folder under `src/blocks/types/` plus one line in
  the registry.

This is why 7 DAYS TO HER and DIVINE MONEY can share an engine, and why
launching something new does not require an engineer.

**2. One person record, not two.** A lead and a member are the same woman at
different moments, so they are the same row. `contacts` is canonical;
`contacts.user_id` is null until she logs in. CRM stage and course progress
hang off that one record as separate concepts. Never split this table.

**3. Journals are encrypted so that even the owner cannot casually read them.**
See below.

---

## The journal privacy model

`journal_entries.body_encrypted` is AES-256-GCM ciphertext produced in the
application before it reaches Postgres. Envelope encryption: each contact has
her own data key, stored wrapped by a master key that lives in the environment,
never in the database.

**The consequence is deliberate.** Opening the database shows nothing readable
— not to a developer, not to a support contractor, not to the owner. Admin
screens read metadata only: entry count, dates, categories, word counts. Enough
to know she is engaged, nothing about what she wrote.

The only path to a body is `journal_shares` — an explicit, revocable share the
member creates herself. Every share-based read writes to `audit_log`.

Deleting her encryption key makes every entry permanently unreadable, which is
how an account deletion request is honoured.

> **Back up `JOURNAL_MASTER_KEY`.** Losing it means losing every journal entry,
> permanently and by design. `npm run verify:crypto` proves this (check 7).

### Three layers of enforcement

1. **`proxy.ts`** on route groups — the coarse gate. It refreshes the session
   cookie and keeps signed-out visitors out of `/my-academy` and `/admin`. With
   no Supabase credentials it fails *closed*. (Next 16 renamed this file
   convention from `middleware` to `proxy`.)
2. **The actor context** (`src/lib/permissions/actor.ts`) — every query
   function takes who is asking as its first argument. There is no overload
   without it, so it cannot be forgotten: the code will not compile. **This is
   where authorization actually lives.**
3. **Postgres row-level security** — the backstop, so a mistake in application
   code does not become a breach. Proven by `npm run verify:rls`.

Named rules live in `src/lib/permissions/policy.ts`.

---

## Layout

```
app/
  (marketing)/   public pages
  (auth)/        login, signup, reset            [Phase 2]
  (member)/      /my-academy
  (admin)/       /admin, incl. the style guide
src/
  blocks/        contract.ts, registry.ts, types/*
  db/
    schema/      drizzle tables, by domain
    migrations/  versioned SQL, in git
    queries/     every query takes an actor context
  design-system/ tokens (in app/globals.css), primitives/, patterns/
  lib/           auth, permissions, crypto, events, utils
  features/      one folder per capability      [Phase 2+]
```

**Three rules that keep this maintainable:**

1. A feature folder may import from `design-system`, `lib` and `db`, but **not
   from another feature**. Cross-feature work goes through events. This is what
   stops the CRM from tangling into the challenge engine.
2. **No query function can be called without an actor context.** Enforced by
   type signature, not by discipline.
3. **Every meaningful action writes an `activity_events` row.** Analytics is
   then a reporting problem, not an instrumentation scramble six months in.

## Design system

Two surfaces, one token set. **Editorial** (public + member) reads like a
premium wellness magazine. **Console** (admin) is dense, neutral and fast.

Rules that are easy to break and expensive to fix:

- `gilt` is for hairlines and small marks. **Never a fill.** Under 5% of a screen.
- No gradient is decorative.
- The four areas (SELF / LOVE / LIFE / WEALTH) are thin rules and small marks,
  never a coloured card.
- Maximum three cards visible at once anywhere in the member portal.
- Every tap target clears 44px. WCAG 2.2 AA is the floor.

Tokens live in `app/globals.css`. Change one, then check `/admin/design`.

---

## Roadmap

1. **Foundation** — *done*
2. **Public site + identity** — *done*
3. **Challenge engine** — *done.* The day experience, HER profile, I CHOSE HER,
   RETURN, journal, HER Code.
4. **LMS + assessments + certificates** — *done.* — admin program builder, pre/post
   assessments, certificate generation and public verification
5. **CRM + commerce** — *done.* — pipeline, Stripe checkout, payment plans, coupons.
   *Money can be taken after this.*
6. **Automation, analytics, hardening** — *done.* — drip sequences, funnel dashboard,
   security review, accessibility audit

## Open decisions

Four of these block later phases; all are documented in the Phase 1
architecture document.

1. Hosting — Vercel or Railway
2. Challenge pacing — strict drip, or allow unlocking days early
   (`programs.allow_early_unlock` supports both; the default still needs setting)
3. Academy price structure — one-time vs payment plan, refund window
   (`offers` supports both; the policy needs deciding before checkout is built)
4. Video in the challenge, community, SMS reminders, dark mode

## The challenge engine

A day is a list of typed blocks rendered by `BlockRenderer`, which looks each
type up in the registry. The day runner never knows what kind of block it is
showing — that is what makes a new programme need no code.

Two things are driven entirely by the block's own definition, never by the
request:

- **`isSensitive`** decides whether the answer is encrypted. Day 2 and Day 3
  are stored exactly like journal bodies.
- **`writesTo`** decides what else it writes — her HER profile, an I CHOSE HER
  entry, a RETURN session, a HER Code, a journal entry.

Every side effect is idempotent on (enrollment, block), so re-saving a block
edits what it wrote rather than duplicating it. This is why editing a Day 6
answer cannot inflate the metric the whole platform is judged on.

### Pacing

Days unlock on a **calendar-day boundary in the timezone she started in**, not
24 hours after sign-up. A day she has already completed never re-locks. Both
rules are in `src/features/challenge/pacing.ts` as pure functions, and both are
tested.

### What is not built

**PDF export of the HER Code.** The HER Code renders as a page built to a phone
screen, because the growth loop is a screenshot posted to Instagram rather than
a downloaded file. A real PDF is a later addition; `her_codes.pdf_url` is
already in the schema for it.

## The admin

`/admin` is **staff only**. `proxy.ts` can only tell whether somebody is signed
in — checking a role needs a database round trip — so the real gate is the
admin layout, which resolves the actor and returns a 404 to anyone who is not
staff. A 404 rather than a redirect, because confirming an admin area exists is
itself information.

### The program builder

`/admin/programs/[id]` builds a programme out of registry blocks. The promise
it keeps: **a new programme needs no code at all.**

Two safeguards are worth knowing about:

- **A version women are working through cannot be edited.** The builder locks
  its structure and offers to publish a new version instead, which is copied
  rather than modified. Nobody mid-challenge has Day 3 change underneath her.
- **Block config is validated against that block type's own Zod schema on the
  server** before it is saved. A config the day runner could not render is
  rejected in the builder, not in front of a woman halfway through Day 3.

### Assessments

Scoring normalises every area to 0–100, excludes open questions, inverts
reverse-scored items, and reports an unanswered area as `null` rather than
zero. An attempt is scored **on the server from the stored questions** — never
from anything the browser sends.

The flow is deliberate: she answers, sees a partial result, and only then gives
an email for the full one. Results open from a link in her inbox without a
login, because asking for an account before she can see something true about
herself is where the funnel dies.

### Certificates

Requirements are evaluated against her real progress when she finishes the last
day. Issuance is idempotent, and one certificate per woman per programme is
enforced by a unique index rather than only by a check.

Two rules that are easy to get backwards, and are tested:

- **A programme with no requirements configured awards nothing.** Silence does
  not mean yes.
- **A programme with no lessons is not "100% complete".** Zero of zero must not
  hand out a certificate.

`/verify/[token]` is public and shows only what is printed on the certificate:
a name, a programme, a date and a number. That is what makes one mean anything.

## Money

**Every amount is an integer number of cents.** `0.1 + 0.2` is not `0.3`, and a
rounding error here charges a real woman the wrong amount. Dollars are
converted to cents once, where a price is entered, and nowhere else.

**Pricing is data.** What the Academy costs is a row in `offers`, editable at
`/admin/offers`. Both shapes the architecture left open — $1,000 once, or three
payments of $375 — are seeded as **drafts**. Nothing is purchasable until you
activate one.

**The price is computed on the server** from the stored offer and the stored
coupon. Nothing about the amount comes from the browser; otherwise a crafted
request could buy the Academy for a penny.

Rules that are tested because they are easy to get backwards:

- A discount can never exceed the price. She must never be owed money.
- A percentage **rounds down**, so a rounding error cannot overcharge.
- Instalments always sum to exactly the total, and the remainder goes on the
  **first** payment — a final payment larger than she agreed to is how disputes
  start.
- The refund window runs from when she **paid**, not when she ordered.

### Webhooks

`/api/webhooks/payments` is public — it has to be — so **the signature is the
only thing between an anonymous HTTP request and a free $1,000 programme.** It
is verified before the body is parsed, and `verify:webhooks` proves it refuses
a wrong secret, a tampered body, a replayed webhook, and a missing secret.

Verification is implemented in `src/lib/payments/signature.ts` rather than
delegated to an SDK, specifically so it can be tested. "We trust the SDK" is
not the same as knowing a forgery is rejected.

**Fulfilment is idempotent**, keyed on the provider's event id. Providers retry
webhooks and deliver them out of order; handling one twice must not enrol her
twice, double her lifetime value, or count a coupon again.

The fake provider (`PAYMENTS_PROVIDER=fake`) approves every payment and is
**refused outright in production**.

## The CRM

Contacts, a pipeline whose columns are `crm_stages` rows, notes, tags,
follow-ups, and stage changes recorded in `contact_stage_history` — which is
how you learn where women stall.

**The contact view shows engagement and never words.** `src/db/queries/crm.ts`
never selects `journalEntries.bodyEncrypted`, and there is deliberately no
function in it that could. `verify:crm-privacy` seeds a woman with a real
encrypted entry and asserts that nothing the contact view or the contact list
returns contains any of it — for a coach *or* an owner.

A contact is **archived, not deleted**. Her orders and certificates are
financial and legal records. Erasing what she *wrote* is a different operation,
done by destroying her encryption key.

## Automations

Two kinds, deliberately separate.

**Rules** react to an event: `challenge.started`, `assessment.completed`, and
so on. A rule matches on the event type plus small conditions over its
metadata, waits a delay, then acts. `enroll_in_program` is deliberately left
unimplemented — an automation that can hand out paid programmes is a hole
waiting to be found.

**Jobs** react to the passage of time, because nothing "happened": a day
opened, or a woman did not come back. Day reminders, stall nudges and
abandoned-checkout emails.

Both run from `POST /api/cron/automations`, hourly. **Call it with
`CRON_SECRET`** — without that variable set the endpoint refuses every request,
because an open endpoint could trigger every email in the system.

**Everything is idempotent.** Rules are keyed on (rule, contact, event); jobs
on what the email is about, including *her local date*. Running the cron twice
in an hour, or having two invocations overlap, sends nothing twice — a run is
claimed before it is acted on, so the loser of a race does nothing.

A run more than 36 hours stale is **skipped rather than sent late**: "Day 2 is
open" arriving on Day 6 is worse than silence.

### Email

Turning off reminders never blocks **transactional** mail — a woman who
silences marketing must not lose her own sign-in links. A **bounced or
complained** address is never written to again. Our own send failures are
recorded as activity, *not* as bounces, so one network blip cannot permanently
suppress her address.

## Analytics

Every funnel number is a query over `activity_events` — which is why writing an
event row for every meaningful action from Phase 1 was worth it. The most
useful screen is day-by-day drop-off: if half of them stop on Day 2, Day 2 is
the problem, and no amount of traffic fixes it.

Journal content appears nowhere and cannot: the queries have no way to read it.

## Security

- **Rate limiting** on the magic-link endpoints. In-memory and per-process, so
  on several instances the effective limit multiplies — a speed bump against a
  script, not a defence against a distributed attack. Moving the store to Redis
  is a drop-in change behind the same interface.
- **Security headers** on every response: `nosniff`, `DENY` framing,
  `strict-origin-when-cross-origin`, a locked-down `Permissions-Policy`, HSTS.
  `x-powered-by` removed. Member and admin pages are `private, no-store`.
- **No Content-Security-Policy yet.** Next injects inline scripts for
  hydration, so a correct CSP needs nonces threaded through the document.
  Shipping a permissive one with `'unsafe-inline'` would look like protection
  while providing almost none, so it is listed here as outstanding rather than
  faked.

## Accessibility

**13 pages, 0 axe violations** against WCAG 2.2 AA, in a real browser. The
audit found real failures the first time it ran — five design tokens below the
contrast threshold, including the four area colours used as 12px badge text.
All were darkened, and `verify:contrast` now reads the tokens straight out of
the stylesheet so a future tweak cannot quietly regress them.

```bash
npm run build && npm start
BASE_URL=http://127.0.0.1:3000 npm run verify:a11y
```

## One thing worth knowing about row-level security

The app connects with `DATABASE_URL`, which on Supabase is the `postgres`
owner — and **an owner bypasses RLS.** So for the app's own queries the real
gate is the actor context in `src/db/queries`, enforced by the type system and
covered by `verify:permissions` and `verify:crm-privacy`. The RLS policies are
a backstop for anything reaching the database another way.

Putting the app itself behind RLS is the right next step for the security
posture, and [DEPLOY.md](./DEPLOY.md) has the SQL. It is not required to
launch, and it is not done by default because it needs the request's user id to
reach Postgres — a change to how every query is issued.

## Placeholders

Copy and data that are **not real yet** are wrapped in `<Placeholder>`, which
renders a visible dashed box. That is deliberate: placeholder content that
looks finished is how invented testimonials ship by accident.

```bash
grep -rn "<Placeholder" app src           # the list should be empty before launch
grep -rn "PLACEHOLDER" scripts/seed-challenge.mts   # the whole curriculum
```

**The seven days are placeholder copy.** `scripts/seed-challenge.mts` builds
the real structure — seven days, nineteen blocks, the right block type in the
right place — but every prompt in it is marked
`[PLACEHOLDER COPY — awaiting the real curriculum]`. The engine is finished;
the words are the product, and they are still to be written.

**The assessment questions are placeholders too**, and are explicitly *not* a
validated instrument. `scripts/seed-assessment.mts` seeds eight scored items
and one open question so the engine can be used; replace them before launch.

`/stories` is deliberately empty. No testimonial is ever invented; real ones
come from the `testimonials` table, which carries `is_placeholder` and
`consented_at` columns for exactly this reason.

## Duty of care

Day 2 asks a woman where she first learned she was not worthy of love. Some
will write about abuse. Before launch this needs:

- a clear "this is education, not therapy" disclaimer;
- a visible crisis-resources link inside the journal and RETURN flows;
- a written policy for what happens if concerning content reaches a human.

The `CrisisResources` component (`src/features/care/CrisisResources.tsx`) is
built and already renders inside the reflection block. **Its resources are US
phone lines and must be confirmed current before launch**, with a plan for
women outside the US. The disclaimer page exists; the written policy does not.

Cheap to build in now, and the main legal exposure if skipped.
