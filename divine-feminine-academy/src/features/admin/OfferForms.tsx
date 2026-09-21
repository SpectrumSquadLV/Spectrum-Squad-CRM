'use client'

import { useActionState, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { Badge, Button, Field, Input } from '@/design-system/primitives'
import {
  createCoupon,
  refundOrder,
  saveOffer,
  setCouponActive,
  type CommerceState,
} from './commerce-actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  )
}

export function OfferForm({
  offerId,
  programs,
  defaults,
}: {
  offerId: string | null
  programs: Array<{ id: string; title: string }>
  defaults?: {
    programId: string
    name: string
    pricingType: string
    priceDollars: string
    installments: number | null
    installmentIntervalDays: number | null
    refundWindowDays: number
    status: string
  }
}) {
  const [state, formAction] = useActionState<CommerceState, FormData>(
    saveOffer.bind(null, offerId),
    {},
  )
  const [pricingType, setPricingType] = useState(
    defaults?.pricingType ?? 'one_time',
  )

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <Field label="Program" htmlFor={`offer-program-${offerId ?? 'new'}`}>
        <select
          name="programId"
          defaultValue={defaults?.programId}
          className="min-h-12 rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
        >
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Name" htmlFor={`offer-name-${offerId ?? 'new'}`}>
        <Input name="name" defaultValue={defaults?.name} required />
      </Field>

      <Field label="Type" htmlFor={`offer-type-${offerId ?? 'new'}`}>
        <select
          name="pricingType"
          value={pricingType}
          onChange={(e) => setPricingType(e.target.value)}
          className="min-h-12 rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
        >
          <option value="free">free</option>
          <option value="one_time">one_time</option>
          <option value="payment_plan">payment_plan</option>
          <option value="subscription">subscription</option>
        </select>
      </Field>

      <Field
        label={pricingType === 'payment_plan' ? 'Per payment ($)' : 'Price ($)'}
        htmlFor={`offer-price-${offerId ?? 'new'}`}
      >
        <Input
          name="priceDollars"
          type="number"
          step="0.01"
          min="0"
          defaultValue={defaults?.priceDollars ?? '0'}
          className="w-32"
        />
      </Field>

      {pricingType === 'payment_plan' && (
        <>
          <Field label="Payments" htmlFor={`offer-inst-${offerId ?? 'new'}`}>
            <Input
              name="installments"
              type="number"
              min="1"
              defaultValue={defaults?.installments ?? 3}
              className="w-20"
            />
          </Field>
          <Field label="Every (days)" htmlFor={`offer-int-${offerId ?? 'new'}`}>
            <Input
              name="installmentIntervalDays"
              type="number"
              min="1"
              defaultValue={defaults?.installmentIntervalDays ?? 30}
              className="w-24"
            />
          </Field>
        </>
      )}

      <Field label="Refund (days)" htmlFor={`offer-refund-${offerId ?? 'new'}`}>
        <Input
          name="refundWindowDays"
          type="number"
          min="0"
          defaultValue={defaults?.refundWindowDays ?? 14}
          className="w-24"
        />
      </Field>

      <Field label="Status" htmlFor={`offer-status-${offerId ?? 'new'}`}>
        <select
          name="status"
          defaultValue={defaults?.status ?? 'draft'}
          className="min-h-12 rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
        >
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="archived">archived</option>
        </select>
      </Field>

      <Submit label={offerId ? 'Save' : 'Create offer'} />

      {state.error && (
        <p role="alert" className="w-full text-2xs text-critical">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="w-full text-2xs text-positive">
          Saved.
        </p>
      )}
    </form>
  )
}

export function CouponForm({
  offers,
}: {
  offers: Array<{ id: string; name: string }>
}) {
  const [state, formAction] = useActionState<CommerceState, FormData>(
    createCoupon,
    {},
  )

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <Field label="Code" htmlFor="coupon-code">
        <Input name="code" placeholder="HER20" className="w-32" />
      </Field>
      <Field label="Type" htmlFor="coupon-type">
        <select
          name="discountType"
          className="min-h-12 rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
        >
          <option value="percent">percent</option>
          <option value="fixed">fixed ($)</option>
        </select>
      </Field>
      <Field label="Value" htmlFor="coupon-value">
        <Input name="discountValue" type="number" step="0.01" min="0" className="w-24" />
      </Field>
      <Field label="Limited to" htmlFor="coupon-offer">
        <select
          name="offerId"
          className="min-h-12 rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
        >
          <option value="">Any offer</option>
          {offers.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Max uses" htmlFor="coupon-max">
        <Input name="maxRedemptions" type="number" min="0" className="w-24" />
      </Field>
      <Field label="Expires" htmlFor="coupon-expires">
        <Input name="expiresAt" type="date" />
      </Field>
      <Submit label="Create coupon" />

      {state.error && (
        <p role="alert" className="w-full text-2xs text-critical">
          {state.error}
        </p>
      )}
    </form>
  )
}

export function CouponToggle({
  couponId,
  isActive,
}: {
  couponId: string
  isActive: boolean
}) {
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await setCouponActive(couponId, !isActive)
        })
      }
      className="text-2xs text-clay-deep hover:text-plum"
    >
      {isActive ? 'deactivate' : 'activate'}
    </button>
  )
}

export function RefundForm({
  orderId,
  refundable,
}: {
  orderId: string
  refundable: string
}) {
  const [state, formAction] = useActionState<CommerceState, FormData>(
    refundOrder.bind(null, orderId),
    {},
  )
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-2xs text-clay-deep hover:text-critical"
      >
        refund
      </button>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <span className="text-2xs text-ink-muted">Refund {refundable}?</span>
      <Input name="reason" placeholder="Reason (optional)" className="min-h-10" />
      <label className="flex items-center gap-2 text-2xs">
        <input type="checkbox" name="override" className="size-3.5 accent-[var(--color-plum)]" />
        Refund even though the window closed
      </label>
      <div className="flex gap-2">
        <Submit label="Refund" />
        <Button type="button" size="sm" variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-2xs text-critical">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-2xs text-positive">
          Refunded.
        </p>
      )}
    </form>
  )
}

export function OfferStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      className={
        status === 'active' ? 'border-positive/40 text-positive' : undefined
      }
    >
      {status}
    </Badge>
  )
}
