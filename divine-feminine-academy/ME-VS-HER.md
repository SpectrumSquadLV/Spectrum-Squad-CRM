# ME VS HER — the seven days

$11. Six days of work and one day of rest. **There is no Day 8.**

> **Status:** the STRUCTURE is built and tested. The WORDS are not written.
> Every prompt in the seeded challenge reads `[NEEDS QUIANA'S INPUT]` and is
> edited in the admin, without a developer and without a deploy.

---

## The days

| | Day | What happens | Mirror |
| --- | --- | --- | --- |
| 1 | **MEET ME** | Awareness and observation. She names ME and ticks what ME does, in ME's own language | ✓ |
| 2 | **MEET YOUR PROTECTOR** | The archetype, and how ME has been protecting her sense of being good enough | ✓ |
| 3 | **FOLLOW THE EMOTION** | The trigger followed backward: event → emotion → reaction → what she was protecting → earlier experience → what she learned about herself | ✓ |
| 4 | **REVIEW THE BELIEF** | The belief on trial. Where from, what supports it, what contradicts it, closer to HER or further, carrying or letting go | ✓ |
| 5 | **THE PROBLEM IS YOU** | The manifestation loop. Ends in celebration — being part of the pattern means being part of the solution | ✓ |
| 6 | **ME VS HER** | The signature exercise. One real choice, made differently, recorded as I CHOSE HER | ✓ |
| 7 | **REST — LET HER LEAD** | No new work. Integration, spoken declaration, retiring ME, closeout | **✗** |

### Day 7 is not another work day

No new belief to dig for. No trigger work. **No mirror gaze.** A test asserts
all four of those, because "one more small exercise" is exactly the kind of
thing that gets added to a rest day six months from now by somebody being
helpful.

What Day 7 has instead:

1. **Her week, read back** — everything she wrote, in her own words
2. **The spoken declaration** (below)
3. **Retiring ME** (below)
4. Her HER Code, the certificate, the share page
5. The invitation into the next thing

---

## The mirror

**Days 1–6: Mirror Gaze.** A real timer with that day's intention held on
screen. She is looking to *find* something.

Three decisions in it worth keeping:

- **No countdown numbers while she looks.** A woman watching a clock is not
  looking at herself. A ring fills, and that is all.
- **It records how long she actually stayed**, not whether she pressed a
  button. Stopping at eleven seconds is recorded as eleven seconds.
- **`seconds_asked` and `seconds_completed` are stored separately.** "She
  started and stopped at eleven seconds" is the most useful number in the
  whole challenge — it is the moment a woman meets her own face and looks
  away, and it is almost certainly where people quit.

**Day 7: Mirror Declaration.** She is no longer looking to discover anything.
She looks herself in the eyes and **speaks as HER**.

The statements are **built from her own six days** — what HER would do, the
choices she actually made, how many times she chose her — not generic
affirmations. A woman reading somebody else's affirmation hears somebody else.
She can edit every line and add her own before she starts.

Then **Declaration Mode**: full screen, one statement at a time, very large,
nothing else in view. She says each one out loud. The last button says
**HER LEADS NOW**.

---

## Retiring ME

ME was not bad. Her job was to make her feel good enough, and she did it for
years. This is not a rejection.

Four sentences, ticked one at a time — because saying them deliberately, one
by one, *is* the ceremony. A single "complete" button would make it an errand.

> I understand you.
> I love you.
> Thank you for protecting me.
> You do not have to do this job any more.

Then the landing:

> ME protected me. I understand her. I love her. She does not have to make me
> feel good enough any more. **I already know I am.**

`her_patterns.retired_at` is set — a column that has existed since the first
migration, for "a pattern she has finished with". The schema believed this
methodology before it was written down.

**It is reversible.** Re-saving without confirming lifts the retirement.
Nothing in this should feel like a door locking behind her.

---

## What was built

### Ten new block types

| Block | Day | Encrypted |
| --- | --- | --- |
| `mirror_gaze` | 1–6 | ✓ |
| `me_portrait` | 1 | — |
| `protector_profile` | 2 | ✓ |
| `emotion_trail` | 3 | ✓ |
| `belief_review` | 4 | ✓ |
| `manifestation_loop` | 5 | ✓ |
| `celebration` | 5 | display only |
| `mirror_declaration` | 7 | ✓ |
| `me_retirement` | 7 | ✓ |
| `callback` | 2–6 | display only |

Plus `my_part` — built before the curriculum arrived, kept in the admin
palette, **not seeded into any day**. It holds the "what was never yours /
what is yours" ordering if you ever want it.

`callback` is the cheapest of the ten and does the most: it shows her
something she wrote on an earlier day. It is what turns seven separate days
into one week that was paying attention.

### One new table

`mirror_sessions` — seconds asked, seconds completed, whether she finished.
**Metadata only.** Anything she wrote afterwards is an encrypted journal entry
like everything else.

The manifestation loop and the retirement letter deliberately did **not** get
their own tables. They are encrypted block responses and a `retired_at` flag on
a column that already existed — three tables would have been three places for
the same truth to disagree.

### Duty of care, in code not copy

Days 4 and 5 are the two screens where the manifestation model could be
misread as *you caused this*. Both carry framing that is **hard-coded, not
editable config** — a test asserts it is not reachable from the admin, so one
rushed edit cannot remove it from the screen where it matters most.

Day 5's is blunt, because its title is `THE PROBLEM IS YOU`:

> You did not cause what was done to you. Nothing on this page is asking you
> to take responsibility for somebody else's behaviour, or for an illness, or
> for what you were born into.

Every block that asks for something painful is marked `isSensitive`, which is
what encrypts it before it reaches Postgres. **A test asserts that for all
eight of them** — a new block added without it would quietly store the worst
thing that ever happened to her in the clear, and nothing would look broken.

---

## Verification

**56 checks** in `verify:curriculum`, on top of the existing suites. The ones
worth naming:

- Seven days, the authoritative titles, in order. No eighth.
- **Day 7 has no mirror gaze**, and digs for nothing new
- The loop is on Day 5, not Day 4
- Every block that asks something painful is encrypted
- The duty-of-care framing is hard-coded, not config
- Her declaration is built from her own material, her words before any generic
  ones, and the same true thing is never said twice
- Stopping the mirror early is recorded as what it was
- ME can be retired, and un-retired

---

## What still needs you

| | What | Why |
| --- | --- | --- |
| **1** | **The prompts for all seven days.** Every one reads `[NEEDS QUIANA'S INPUT]` | This is the product |
| **2** | **The six mirror intentions**, one per day, tied to that day's work | The mirror is daily and the intention is the practice |
| **3** | **Confirm the crisis numbers**, and the policy for concerning content | Unverified US lines, on Day 3 and Day 5 |
| **4** | The four retirement sentences, if you want them worded differently | Defaults are in place and match the methodology |
| **5** | The Day 7 fallback declarations, for a woman who skipped days | Her own material is used first regardless |
| **6** | A price and a shape for The Divine Feminine | The Day 7 invitation is a waitlist until then |

### Not waiting on

The Divine Feminine curriculum. It stays an empty container with a waitlist,
exactly as instructed.

### Known gap, worth naming

Her declaration is currently built from her **unencrypted** material: her
patterns and her I CHOSE HER moments. The richer sources named in the
methodology — the old belief, what ME was protecting, what she is no longer
letting determine her worth — live in encrypted Day 2–4 responses, and reading
them back requires decrypting her own entries server-side for her own eyes.

That is doable and it is her own data. It is a deliberate follow-up rather
than something to rush, because it touches the encryption path and that is the
one part of this system that must never be loosened casually.
