# ME VS. HER — the seven days

$11. Seven days, and **there is no Day 8.**

> **Status:** built and seeded. Every word of the curriculum is Quiana's,
> reproduced exactly as approved. It lives in
> `src/features/challenge/curriculum.ts` so it can be tested rather than only
> run, and `npm run verify:me-vs-her` checks it without needing a database.

---

## The core idea

See ME → Understand ME → Love ME → Recognize what ME has been creating →
Meet HER → Choose HER → Let HER lead.

- ME was created to protect her. The goal is never to shame, kill or reject
  ME.
- ME needs to be SEEN, UNDERSTOOD, LOVED and THANKED, and then she retires
  from leading.
- HER is not a different woman. HER is who she becomes when old beliefs stop
  making her decisions.
- **ME is not the body, and ME is not the soul.** ME is the collection of
  protective identities, behaviours, stories and strategies she built through
  experience.
- **HER existed before all of it.** She is not creating HER from scratch; she
  is removing what has hidden HER.
- End state: **"I am worthy of everything I desire."**

---

## The days

| | Day | What happens | Mirror |
| --- | --- | --- | --- |
| 1 | **SEE ME** | She meets the version of herself that shows up automatically. Observation only, and quick | 1:00 |
| 2 | **UNDERSTAND ME** | Where ME might have learned it. The heaviest day | 2:00 |
| 3 | **LOVE ME** | Compassion replaces shame. Ends in the statement to ME | 2:00 |
| 4 | **RECOGNIZE WHAT ME HAS BEEN CREATING** | One realization: ME has been participating in creating her life. ME behaviour → RESULT, and nothing else | 3:00 |
| 5 | **MEET HER** | The first day HER appears. She only SEES her. Light and expansive | 3:00 |
| 6 | **CHOOSE HER** | The choice point, the pause, and ONE intentional action | 3:00 |
| 7 | **ME VS. HER** | The culmination. One real decision, looked at through ME, then HER, then chosen | **✗** |

### Day 7 has no mirror

Every other day ends at one. Day 7 ends in a decision and an action instead,
because she has stopped looking for something and started choosing. A test
asserts it, along with the timers on the other six, because "one more small
exercise" is exactly the kind of thing that gets added six months from now by
somebody being helpful.

### Day 7 is not a summary

It is not a reflection, a retirement ceremony or a closeout. The real
decision is the centrepiece, and the rules around it are load-bearing:

1. ONE real current decision, not a hypothetical.
2. It stays visible from Screen 4 through Screen 11.
3. **ME answers first.** HER answers second.
4. Both are shown side by side before she chooses.
5. The system never decides or suggests what HER would do.
6. HER's choice is never implied to be objectively correct.
7. ME is never shamed. ME's response is information.
8. It ends in action, not insight.

### Choosing ME is allowed

This is the rule most likely to be quietly broken by a later change, so it is
worth stating plainly: on Day 7 she may consciously choose ME, and the
product must never punish her for it.

That means all of the following, each of which took a deliberate decision:

- The ME and HER buttons are equal. Same variant, same size, same width.
  Neither is preselected.
- Choosing ME shows the comparison once more and lets her choose again — then
  continues with no argument if she stays.
- The **certificate does not require choosing HER.** Requiring it would have
  meant telling her the choice was free and then withholding something for
  it.
- The follow-up email's opening line changes ("Yesterday, you chose HER" vs
  "Yesterday, you finished ME VS. HER") and **nothing else does.**

The choice counter still only counts HER, because "You've chosen HER n times"
has to stay true.

---

## The scope guard

ME VS. HER creates awareness, clarity and the first identity shift. It does
**not** teach Academy content.

**No belief is named anywhere in the seven days.** No subconscious
programming, no neuroscience, no manifestation loop, no trauma theory, no
retirement ceremony. Those block types still exist in the registry because
the Academy is built from the same engine — `verify:me-vs-her` asserts none
of them appear in the challenge.

There is also **no RETURN**, anywhere. ME VS. HER is the only framework: a
second one sitting beside it asked a woman to remember two things on the day
she can least afford to.

---

## The four life areas

**HERSELF · RELATIONSHIPS · MONEY · SUCCESS**, used across the whole
platform. They replaced an earlier self/love/life/wealth set; migration 0012
renames the enum values in place so existing rows keep their meaning.

Day 4 asks her to look at ONE of them. Day 5 asks what she would allow
herself to want in all four, and those four answers become `her_desires` —
read back to her that same day as THIS IS HER, offered again on Day 6, and
available on Day 7. They outlive the challenge, because a woman should never
be asked what she wants twice.

---

## The quiz is NOT part of this

The archetype quiz is a separate, standalone product that routes women into
either ME VS. HER or the Divine Feminine Academy. Nothing in the challenge
depends on quiz results.

---

## What she keeps afterwards

- **The tool.** `/my-academy/me-vs-her/tool` — the same four questions, under
  two minutes, available forever once Day 7 is done and gated on FINISHING
  rather than enrolling.
- **The card.** Every line editable before she keeps it. Nothing is ever
  shared automatically.
- **Everything she wrote.** Encrypted with her own key.
- **The count.** "You've chosen HER n times", on her home screen.

---

## Privacy

Her journal bodies, her Day 2 answers, her four desires and her Day 7
decision are all encrypted with her own key, wrapped by a master key held as
a Railway secret. Admins and the owner see metadata only: dates, counts, word
counts.

`her_desires` has no staff select policy at all. There is no emergency
access, and deleting her account deletes her key.

`verify:me-vs-her` checks every block that collects something painful is
marked `isSensitive`, because that flag is what decides whether her answer is
encrypted before it reaches Postgres — and a block added without it would
store the worst thing that ever happened to her in the clear, with nothing
looking broken.

---

## Test mode

Staff accounts open all seven days at once, for QA. It bypasses the 24-hour
release timing and **nothing else**: database writes, callbacks, mirror
timers, Day 7 logic, the completion state, the tool, the Academy CTA and the
follow-up email all behave exactly as they do in production.

It is a per-request flag read from the actor, not a field on an enrollment,
so there is nothing on a real client to set by accident.
