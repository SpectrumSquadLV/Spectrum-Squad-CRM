# What the big names have that we do not

A gap list, measured against Kathrin Zenkina (Manifestation Babe), Myron Golden
and Tony Robbins. Ranked by what would move your numbers most, not by what is
most fun to build.

## Read this first: how solid this is

**I could not load any of the three websites.** This environment's network
proxy blocks `manifestationbabe.com`, `tonyrobbins.com` and `myrongolden.com`
outright — not a bot block on their end, a denial on ours. I tried both the
apex and `www`, and specific paths. Nothing got through.

So this is built from web search results and from how this category works, not
from reading their pages. Treat it as a strong starting hypothesis, not an
audit. Anything marked **(verified)** came back in a search result; everything
else is category knowledge and you should sanity-check it by opening the sites
yourself, which takes about ten minutes.

What did come back in searches:

- Tony Robbins gives away a **free DISC personality assessment** and you
  download your results — email for report. He also has a Wheel of Life
  assessment. **(verified)**
- Myron Golden's engine is the **Make More Offers Challenge**, a five-day live
  challenge, with a free training video suite gated behind an email.
  **(verified)**
- Kathrin Zenkina runs Manifestation Babe plus a separate Academy site, and a
  podcast with **3M+ downloads and 2,500+ reviews**. **(verified)**
- Archetype quizzes are the standard lead magnet in her category: 8–13
  questions, under five minutes, results by email, named types like "The
  Visualizer" / "The Scriptor". **(verified)**
- Benchmarks: personality/recommendation quizzes average **~40% lead
  conversion**, versus **5–10% for a gated PDF**; well-built ones exceed 50%.
  Quizzes with fewer than three form fields and mobile-first design convert
  best. **(verified)**

That last number is the whole argument for what got built this round.

---

## Now closed

**A quiz funnel.** Twelve questions, four archetypes, ninety seconds, two form
fields, mobile-first, results gated behind an email, a shareable public page
per archetype with its own social card. See `README.md` for how it works and
`src/features/quiz/archetypes.ts` for the words.

**Being findable.** There was no `sitemap.xml` and no `robots.txt` — so the
public pages were only as discoverable as whatever linked to them, and the
private ones (her result, her certificate) had nothing telling a crawler to
stay out. Both now exist.

---

## Still missing, ranked

### 1. A content engine — the biggest gap by a distance

All three are content businesses first. Kathrin's podcast has **3M+ downloads**
and it is the top of her entire funnel. Tony Robbins runs a large blog that
ranks for enormous numbers of search terms. We have **twelve public pages and
no blog, no podcast page, no article template, and no way to publish anything
without a developer.**

A quiz gets you the woman who already found you. Content is how she finds you
at all, and nothing else on this list substitutes for it.

*What it needs:* an article model, an editor, an article template with proper
schema markup, and a per-article opt-in ("get the worksheet from this post").

### 2. Live cohorts with a date, a countdown and a waitlist

Myron's whole business is a **five-day live challenge**. Tony sells live
events. Kathrin launches her Academy in cohorts. Every one of them runs on
*this closes on Friday*.

Everything here is evergreen and self-paced, which means nothing on the site
ever has a reason to be bought today. That is the single most expensive
difference on this page.

*What it needs:* start dates on a program, a waitlist, a countdown, an
enrolment window that opens and closes, and a replay.

### 3. Social proof, collected and displayed

All three lead with it — numbers, testimonials, logos, student counts.
`/stories` is deliberately empty and there is no way to collect a testimonial,
approve it, or put it on a page. The database table exists; nothing else does.

*What it needs:* a request flow (ask a woman who just finished Day 7), an
approval screen, and a component that can be dropped on any page.

### 4. Order bumps and upsells

Myron Golden is *the* offer-stacking teacher. Checkout takes one thing at one
price. There is no tick-box bump at checkout and no offer after the card
clears — which is the cheapest revenue in the whole business, because she has
already decided to trust you.

### 5. A high-ticket application funnel

Myron and Tony both sell four- and five-figure programmes through an
application and a call, never a buy button. We have self-serve checkout only,
so there is currently no way to sell anything expensive.

*What it needs:* an application form, a qualifying question set, a booking
link, and a CRM stage that tracks it.

### 6. A webinar or masterclass registration flow

Standard for all three: register, attend live, watch the replay for 48 hours,
buy. Nothing here does this.

### 7. Per-archetype email sequences

The quiz already tags her and fires a `quiz.completed` event carrying her
archetype, so the automation engine can branch on it today — `equals:
{ archetype: 'sulk' }` is the whole condition. **What is missing is the
words.** Four sequences of three to five emails each. That is yours to write,
and it is probably the highest-return writing you will do this year.

### 8. An affiliate or referral programme

Kathrin and Tony both run affiliates. Nothing here tracks a referral, attributes
a sale, or pays anybody.

### 9. Ad tracking

No Meta pixel, no Google Analytics, no conversion events. All three run paid
traffic. The moment you spend a pound on ads you will be flying blind, and you
cannot retro-fit data you never collected.

### 10. Broadcast email

The automation engine sends triggered email well. There is no way to write one
email and send it to everybody, which is what a newsletter is.

### 11. SMS

`send_sms` exists in the automation actions and has no provider behind it. It
will fail silently if a rule ever uses it.

### 12. A community

Kathrin has a membership community; Tony has coaching and events. There is no
forum, group, or cohort chat here — every woman does this alone.

---

## If you only do three things

1. **Write the four archetype email sequences.** The machinery is already
   waiting for them, and this is the difference between a quiz that collects
   emails and a quiz that sells.
2. **Put a date on something.** One live cohort, one countdown. This is the
   cheapest large change on the list.
3. **Start publishing.** One article or episode a week, consistently, beats
   everything else here over a year — and it is the one that compounds.
