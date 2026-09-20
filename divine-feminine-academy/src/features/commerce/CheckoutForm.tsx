'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input } from '@/design-system/primitives'
import { startCheckout, type CheckoutState } from './actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Taking you to checkout…' : label}
    </Button>
  )
}

/**
 * Checkout.
 *
 * Card details are never typed here — this form hands off to a hosted checkout
 * page, which is why no payment data ever reaches our servers. The price is
 * computed on the server from the stored offer; nothing about the amount is
 * sent from this form.
 */
export function CheckoutForm({
  offerId,
  cohortId,
  priceLabel,
  planNote,
  refundNote,
  signedInEmail,
}: {
  offerId: string
  /** Set when this is a seat in a live run rather than evergreen access. */
  cohortId?: string
  priceLabel: string
  planNote?: string
  refundNote?: string
  signedInEmail?: string | null
}) {
  const [state, formAction] = useActionState<CheckoutState, FormData>(
    startCheckout,
    {},
  )
  const [showCoupon, setShowCoupon] = useState(false)

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="offerId" value={offerId} />
      {cohortId && <input type="hidden" name="cohortId" value={cohortId} />}

      <div>
        <p className="font-display text-3xl">{priceLabel}</p>
        {planNote && <p className="mt-1 text-xs text-ink-muted">{planNote}</p>}
      </div>

      {!signedInEmail && (
        <Field label="First name" htmlFor="checkout-name">
          <Input name="firstName" autoComplete="given-name" />
        </Field>
      )}

      <Field label="Email" htmlFor="checkout-email">
        <Input
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          defaultValue={signedInEmail ?? ''}
          required
        />
      </Field>

      {showCoupon ? (
        <Field label="Code" htmlFor="checkout-coupon">
          <Input name="couponCode" autoCapitalize="characters" />
        </Field>
      ) : (
        <button
          type="button"
          onClick={() => setShowCoupon(true)}
          className="self-start text-2xs text-ink-muted underline underline-offset-4 hover:text-ink"
        >
          I have a code
        </button>
      )}

      {state.error && (
        <p role="alert" className="text-2xs text-critical">
          {state.error}
        </p>
      )}

      <Submit label="Continue to payment" />

      <p className="text-2xs text-ink-muted">
        Payment is handled by our payment provider — your card details never
        touch our servers.
        {refundNote ? ` ${refundNote}` : ''}
      </p>
    </form>
  )
}
