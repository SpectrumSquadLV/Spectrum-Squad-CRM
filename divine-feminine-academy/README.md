# Divine Feminine Academy

A website: one Next.js app serving three faces on one domain.

- **Public site** — indexed marketing pages, where social traffic lands.
- **Member portal** (`/my-academy`) — where a woman actually spends her time.
- **Admin / CRM** (`/admin`) — behind a staff login.

Mobile-first. Most women arrive on a phone from Instagram.

**Phases 1–3 are built**: the foundation, the public site and identity, and
the challenge engine. **7 DAYS TO HER runs end to end** — against placeholder
curriculum copy, because the real prompts are not written yet.

There is no checkout and no CRM screens — see the roadmap below.

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
| 7 DAYS TO HER curriculum | **Placeholder copy only** |
| PDF export of the HER Code | **Not built** — see below |
| CRM screens, checkout | **Not built** — Phase 5 |

## Running it

```bash
cp .env.example .env.local   # then fill it in
npm install
npm run dev                  # http://localhost:3000
```

Look at **`/admin/design`** first. Every token and primitive renders there.

```bash
npm run typecheck      # tsc, strict
npm run build          # production build
npm run verify:crypto  # 8 checks on journal encryption
npm run verify:pacing  # 17 checks on drip unlocking and timezones
npm run verify:engine  # 12 checks on the challenge engine (needs DATABASE_URL)
npm run verify:rls     # 11 checks that RLS really isolates members
npm run seed:challenge # seed 7 DAYS TO HER (placeholder curriculum)
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
4. **LMS + assessments + certificates** — *next.* — admin program builder, pre/post
   assessments, certificate generation and public verification
5. **CRM + commerce** — pipeline, Stripe checkout, payment plans, coupons.
   *Money can be taken after this.*
6. **Automation, analytics, hardening** — drip sequences, funnel dashboard,
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
