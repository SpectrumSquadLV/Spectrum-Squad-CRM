# ME VS HER — the planning package

The 7-day challenge. $11. The way in.

---

## First: what I actually received, and what I did with it

Your methodology arrived as **§1 THE CORE PHILOSOPHY** and **§2 MANIFESTATION
MUST UNDERPIN THE ENTIRE EXPERIENCE**. It ends mid-sentence at *"I gain access
to something I can change"* — no §3, and no planning-package request at the end
(which you later referred to). The day-by-day curriculum was not in it.

**I have not invented it, and I have not waited for it.** Instead:

> Your progression has exactly seven stages.
>
> **See ME → Understand ME → Love ME → Recognize what ME has been creating →
> Meet HER → Choose HER → Let HER lead**

Seven stages, seven days. That is not my structure — it is yours, read off your
own document. Everything below is built on it. Where a day needs *words* rather
than *structure*, it is marked **NEEDS QUIANA'S INPUT** and the system is built
so you can fill it in without a developer.

---

## A. The user journey

```
        Instagram / a friend's share / something you wrote
                              │
                              ▼
                   THE QUIZ  (free, 90 seconds)
            "Which version of ME is running the show?"
                              │
                              ▼
                  MEET YOUR ME  ·  the result page
        The Commander · The Escape Artist · The Watcher · The Quiet Storm
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
           5 emails over 9 days    straight to the offer
                    └─────────┬─────────┘
                              ▼
                     ME VS HER  ·  $11
                              │
                              ▼
        ┌─────────────── THE SEVEN DAYS ───────────────┐
        │  1 See ME            ← her quiz ME, pre-filled │
        │  2 Understand ME                               │
        │  3 Love ME                                     │
        │  4 Recognize what ME has been creating         │
        │  5 Meet HER                                    │
        │  6 Choose HER                                  │
        │  7 Let HER lead  →  ME RETIRES                 │
        └────────────────────┬───────────────────────────┘
                             ▼
              HER CODE  ·  certificate  ·  share page
                             ▼
           THE DIVINE FEMININE  — the next container
                  (architecture only, no curriculum)
```

**What changed from before.** The quiz used to be a separate curiosity beside
the challenge. It is now the **front door**: her quiz result is her ME, and Day
1 opens with it already on the screen. She does not meet her ME twice.

**The join that makes this work.** Her archetype is stored on her contact
record the moment she finishes the quiz. Day 1 reads it. If she bought without
taking the quiz, Day 1 offers it inline instead — the only difference is who
does the naming.

---

## B. The seven days — screens and interactions

Every day is the same shape: **arrive → one or two real interactions → something
saved → something shown back.** About twenty minutes, on a phone.

The rightmost column is what makes it an experience rather than seven
worksheets: **what the platform shows her that it could only know because she
told it earlier.**

| Day | Stage | The interaction | Saved as | Called back |
| --- | --- | --- | --- | --- |
| **1** | See ME | Her quiz archetype, then the strategies she actually uses — chosen from ME's own list: defend, control, withdraw, escape, prove, seek validation, distract, cut off, question herself, avoid, keep score, manage how she is seen | `her_patterns` (trigger + current response + tags) | — |
| **2** | Understand ME | When did ME learn this? The moment, and what she concluded from it. **Heaviest day.** Encrypted. | `her_patterns.currentResponse`, journal entry | Her Day 1 strategies, named back |
| **3** | Love ME | **Mirror timer** — a real countdown, looking at herself, one line held on screen. Then a letter *to* ME. | `mirror_sessions`, encrypted journal entry | The belief from Day 2 |
| **4** | Recognize what ME has been creating | **The loop.** Experience → Meaning → Belief → Expectation → Attention → Evidence → Stronger Belief, one field per screen, filled in with her own example | `manifestation_loops` (encrypted) | Her Day 2 belief drops straight into the Belief field |
| **5** | Meet HER | Same trigger from Day 1, other column: what would HER do? Plus the RETURN practice — six questions and one action, hers for life | `her_patterns.herResponse`, `return_sessions` | Day 1's trigger, verbatim |
| **6** | Choose HER | **A choice point.** A real situation from her own week: what ME would do, what HER would do, which she chose | `her_choices` | Her Day 5 HER response |
| **7** | Let HER lead | **Retirement.** She writes what ME protected her from and thanks her. ME is marked retired. Then the HER Code. | `her_patterns.retiredAt`, `her_codes` | **Everything.** Her whole week read back to her |

### Day 7 is the one that matters

`her_patterns` already has a **`retired_at`** column. It was built for "a
pattern she has finished with" — which is exactly ME being understood, thanked,
and allowed to put the job down. The database already believed your
methodology before it was written down.

So Day 7 is not a summary screen. It is a ceremony:

1. Her week, read back — her trigger, her belief, her loop, her HER response, every choice she logged
2. The letter retiring ME. Encrypted, hers alone
3. `retired_at` set. ME does not disappear from her record; she is marked as having finished a job
4. The HER Code, built from her own words
5. Certificate + a share page

**NEEDS QUIANA'S INPUT:** the actual prompts for all seven days, the mirror
timer's length and the line held on screen during it, and the wording of the
retirement letter. These are the words. The structure holds without them; the
product does not.

---

## C. Component architecture

The engine already works this way: **a day is a list of typed blocks**, each
block is one folder plus one registry line, and a new programme needs no code
at all. Fourteen block types exist.

### What already exists and carries straight over

| Block | Used on | Note |
| --- | --- | --- |
| `dual-column-exercise` | Days 1 and 5 | ME column and HER column. Already writes `her_patterns` |
| `belief-origin` | Day 2 | Already sensitive → encrypted |
| `validation-audit` | Day 3 or 4 | Whose approval she is arranging her life around |
| `return-practice` | Day 5 | Six questions, one action |
| `her-choice-capture` | Day 6 | Already writes `her_choices` |
| `her-code-builder` | Day 7 | Already writes `her_codes` |
| `evidence-review` | Day 7 | Already reads her own week back (`resolvesContext`) |
| `reflection-prompt`, `journal-prompt`, `rich-text`, `video`, `milestone`, `action-commitment`, `behavior-commitment` | throughout | |

### What has to be built — six new block types

| New block | Day | What it does | Sensitive? | Writes |
| --- | --- | --- | --- | --- |
| `me-portrait` | 1 | Her archetype plus a multi-select of ME's strategies, in ME's own language | no | `her_patterns.currentTags` |
| `mirror-gaze` | 3 | A real timer. One line held on screen. Optional reflection after | reflection: **yes** | `mirror_sessions` |
| `letter-to-me` | 3 | A letter written *to* ME, with love | **yes** | journal entry |
| `manifestation-loop` | 4 | The seven-step loop, one field per screen, her own example | **yes** | `manifestation_loops` |
| `me-retirement` | 7 | Thanks ME, names what she protected, retires her | **yes** | `her_patterns.retiredAt` + journal |
| `callback` | 2–7 | Display only. Shows her something she wrote on an earlier day | n/a | nothing |

`callback` is the cheapest of the six and does the most work. It is what turns
seven separate days into one week that was paying attention.

### The rules a new block obeys

Each is a folder of three files — `schema.ts`, `Member.tsx` (`'use client'`),
`index.ts` (plain) — because a definition exported from a client module arrives
on the server with every field `undefined`, which once silently switched
encryption off. The definition declares `isSensitive` (→ encrypted before it
reaches Postgres) and `writesTo` (→ what else it updates). **Neither is ever
taken from the request.**

### Beyond blocks

- **Progress spiral** on her home screen — seven stages, where she is, what she has already made. Not a block; part of the day runner.
- **Celebration moments** at Days 4 and 7, built from her own numbers rather than confetti for its own sake.

---

## D. Data and persistence

Most of it already exists. `her_patterns`, `her_choices`, `return_sessions`,
`her_codes`, `journal_entries` and per-contact encryption are all built and
tested.

### Three new tables

```
mirror_sessions        contact, enrollment, day, seconds asked,
                       seconds completed, completed_at,
                       reflection (encrypted, optional)

manifestation_loops    contact, enrollment, the seven fields (encrypted),
                       the belief it produced, created_at

me_retirements         contact, enrollment, letter (encrypted),
                       retired_at, what ME protected (encrypted)
```

`mirror_sessions` keeps seconds asked *and* seconds completed separately,
because "she started it and stopped at forty seconds" is the single most
interesting number in the whole challenge — it is the day people quit.

### One column, no new table

Day 1's ME strategies go in `her_patterns.currentTags`, which is already a text
array. No migration.

### What stays encrypted

Everything she writes on Days 2, 3, 4 and 7. Per-contact key, wrapped by the
master key, sealed before it reaches the database. The admin sees that she
wrote, how much, and when — **never a word of what.** That is already true and
tested, and the new blocks inherit it by declaring `isSensitive`.

### Duty of care, in code

Your §2 draws a line I have to keep: never imply she caused abuse, trauma,
illness, poverty, discrimination, or another person's behaviour.

- The Day 4 loop block carries a fixed, non-editable framing line above the fields: this is about **the part of the pattern that belongs to her**, which is the part she can change.
- `CrisisResources` already renders on the heavy days. Day 2 and Day 4 are the two that need it most.
- **NEEDS QUIANA'S INPUT:** the crisis numbers are still unconfirmed US lines, there is nothing for women outside the US, and there is no written policy for what happens when something concerning is written. This is the one open item I would not launch without.

---

## E. Challenge → The Divine Feminine

**The Academy exists architecturally and has no curriculum. That is the
correct state and nothing below invents one.**

What happens when she finishes Day 7:

1. HER Code, finalised, hers
2. Certificate issued against real progress, publicly verifiable
3. A share page — the growth loop
4. **And then the invitation**

The invitation is the transition, and right now it can only honestly be a
**waitlist**, because The Divine Feminine has no curriculum and no price. Its
two offers are seeded as drafts on purpose.

So the Day 7 completion screen offers: *the deeper work is being built — be
told when it opens.* She joins a list. When you have the curriculum and a
price, that list is who you tell first, and they are the warmest audience you
will ever have: women who just finished something of yours.

**The machinery for this already exists** — the cohort waitlist built last
week is exactly this shape, and needs no new code to point at a programme
instead of a cohort.

**NEEDS QUIANA'S INPUT:** the curriculum, the price, and whether The Divine
Feminine is self-paced, cohort-based, or a membership. That last one changes
the architecture more than the other two.

---

## F. What genuinely needs you

Ranked. The first one blocks launch; the rest do not.

| | What | Why it blocks |
| --- | --- | --- |
| **1** | **The seven days of prompts.** Every block on every day is still `[PLACEHOLDER COPY]` | This *is* the product. Nothing else on this list matters until it exists |
| **2** | **Confirm the crisis numbers** in `CrisisResources`, and decide what happens when something concerning is written | Unverified phone lines in front of a woman on Day 2 |
| **3** | **Does the 7-stage → 7-day mapping match what you wrote?** I derived it from your progression | Everything in this document assumes it |
| **4** | **The mirror timer**: how long, and what line stays on screen | It is one of the few genuinely embodied moments |
| **5** | **The retirement letter wording** on Day 7 | The emotional peak of the whole thing |
| **6** | A price for The Divine Feminine, and its shape | Blocks the transition being anything but a waitlist |
| **7** | Legal pages read by a lawyer | Not launch-blocking, but do not leave it |

### What I am *not* waiting for

The Divine Feminine curriculum. It stays an empty container with a waitlist
until you write it, and nothing here depends on it.

---

## Build order, once the prompts land

1. The six new block types, with tests — each is a folder plus a registry line
2. The three new tables, one migration
3. Re-seed the seven days against the real curriculum
4. The progress spiral and the two celebration moments
5. The Day 7 ceremony, end to end
6. The completion → waitlist transition
7. The whole thing driven in a real browser at 390px, as every other journey is

Steps 1, 2, 4 and 6 do not need the words and can be built now. Steps 3, 5 and
7 cannot.
