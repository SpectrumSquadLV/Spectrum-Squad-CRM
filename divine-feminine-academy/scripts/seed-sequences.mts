/**
 * Seeds the automation rules that send the four archetype sequences.
 *
 * Step 1 is deliberately NOT a rule. It is sent in-process the moment she
 * joins, because "check your inbox" followed by up to an hour of nothing is a
 * promise that is false exactly when she is still looking. Steps 2 to 5 are
 * rules on a delay, which is what the automation engine is for.
 *
 * Every rule triggers on `archetype.assigned` and is conditioned on the
 * archetype in that event's metadata, so the quiz and the opt-in form both
 * feed the same sixteen rules.
 *
 * The rules are seeded ACTIVE. They send copy that exists and is complete, and
 * a sequence nobody remembered to switch on is the most common way a launch
 * quietly collects addresses and mails none of them.
 *
 * Idempotent: re-running updates the existing rules in place rather than
 * creating a second set, which would double every email.
 *
 * Run: DATABASE_URL=... npm run seed:sequences
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { automationRules } from '../src/db/schema/activity'
import { archetypes, modes } from '../src/features/quiz/archetypes'
import { sequences } from '../src/features/quiz/sequences'

const TRIGGER = 'archetype.assigned'

async function main() {
  let created = 0
  let updated = 0

  for (const mode of modes) {
    const archetype = archetypes[mode]

    for (const email of sequences[mode]) {
      // Step 1 goes out in the request that creates the subscription.
      if (email.step === 1) continue

      const name = `${archetype.name} — email ${email.step}`
      const delayMinutes = email.afterDays * 24 * 60

      const values = {
        name,
        triggerEvent: TRIGGER,
        conditions: { equals: { archetype: mode } },
        delayMinutes,
        action: 'send_email' as const,
        actionConfig: {
          template: 'archetypeSequence',
          archetype: mode,
          step: email.step,
        },
        isActive: true,
      }

      const [existing] = await db
        .select({ id: automationRules.id })
        .from(automationRules)
        .where(
          and(
            eq(automationRules.name, name),
            eq(automationRules.triggerEvent, TRIGGER),
          ),
        )
        .limit(1)

      if (existing) {
        await db
          .update(automationRules)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(automationRules.id, existing.id))
        updated++
      } else {
        await db.insert(automationRules).values(values)
        created++
      }
    }
  }

  console.log(
    `archetype sequences: ${created} rule(s) created, ${updated} updated, all active`,
  )
  console.log('step 1 of each sequence is sent in-process, not by a rule')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
