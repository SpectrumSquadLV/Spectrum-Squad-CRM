/**
 * Preflight: is this deployment actually configured?
 *
 * A half-configured deploy is worse than one that refuses to start. Without a
 * Resend key the app silently discards every sign-in link, and a woman is
 * locked out of her own account with nothing to tell her why. This turns that
 * class of failure into a loud one, before anybody is affected.
 *
 * Pure: it takes an environment object rather than reading `process.env`, so
 * every rule can be tested without one.
 */

export type Severity = 'error' | 'warning' | 'ok'

export interface CheckResult {
  key: string
  severity: Severity
  message: string
}

export interface PreflightReport {
  environment: 'production' | 'development'
  results: CheckResult[]
  errors: CheckResult[]
  warnings: CheckResult[]
  ok: boolean
}

export type Env = Record<string, string | undefined>

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== ''

/** 32 bytes of base64, or the journal cannot be read or written. */
export function checkMasterKey(value: string | undefined): CheckResult {
  const key = 'JOURNAL_MASTER_KEY'

  if (!present(value)) {
    return {
      key,
      severity: 'error',
      message:
        'Not set. Journals cannot be written or read. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    }
  }

  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64')
  } catch {
    return { key, severity: 'error', message: 'Not valid base64.' }
  }

  // Buffer.from is lenient, so a short or non-base64 string decodes to
  // something — the length check is what actually catches a bad key.
  if (decoded.length !== 32) {
    return {
      key,
      severity: 'error',
      message: `Must decode to exactly 32 bytes; this decodes to ${decoded.length}.`,
    }
  }

  return { key, severity: 'ok', message: '32 bytes. Back it up somewhere you trust.' }
}

export function checkDatabaseUrl(value: string | undefined): CheckResult {
  const key = 'DATABASE_URL'
  if (!present(value)) {
    return { key, severity: 'error', message: 'Not set. Nothing will work.' }
  }
  if (!/^postgres(ql)?:\/\//.test(value)) {
    return {
      key,
      severity: 'error',
      message: 'Does not look like a postgres:// connection string.',
    }
  }
  return { key, severity: 'ok', message: 'Set.' }
}

export function checkSiteUrl(
  value: string | undefined,
  isProduction: boolean,
): CheckResult {
  const key = 'NEXT_PUBLIC_SITE_URL'
  if (!present(value)) {
    return {
      key,
      severity: isProduction ? 'error' : 'warning',
      message:
        'Not set. Magic links, share links and webhook callbacks will point at localhost.',
    }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { key, severity: 'error', message: 'Not a valid absolute URL.' }
  }

  if (isProduction && url.protocol !== 'https:') {
    return {
      key,
      severity: 'error',
      message: 'Must be https in production — sign-in links are sent to this host.',
    }
  }
  if (value.endsWith('/')) {
    return {
      key,
      severity: 'warning',
      message: 'Has a trailing slash, which produces double slashes in links.',
    }
  }
  return { key, severity: 'ok', message: value }
}

function required(
  env: Env,
  key: string,
  isProduction: boolean,
  what: string,
): CheckResult {
  if (present(env[key])) return { key, severity: 'ok', message: 'Set.' }
  return {
    key,
    severity: isProduction ? 'error' : 'warning',
    message: `Not set. ${what}`,
  }
}

export function runPreflight(env: Env): PreflightReport {
  const isProduction = env.NODE_ENV === 'production'
  const results: CheckResult[] = []

  results.push(checkDatabaseUrl(env.DATABASE_URL))
  results.push(checkMasterKey(env.JOURNAL_MASTER_KEY))
  results.push(checkSiteUrl(env.NEXT_PUBLIC_SITE_URL, isProduction))

  results.push(
    required(env, 'NEXT_PUBLIC_SUPABASE_URL', isProduction, 'Nobody can sign in.'),
    required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', isProduction, 'Nobody can sign in.'),
  )

  // --- Email -------------------------------------------------------------
  const emailIsFake =
    env.EMAIL_PROVIDER === 'fake' || !present(env.RESEND_API_KEY)

  if (emailIsFake) {
    results.push({
      key: 'RESEND_API_KEY',
      severity: isProduction ? 'error' : 'warning',
      message: isProduction
        ? 'Not set, so every email is DISCARDED — including sign-in links. Women will be locked out with no explanation.'
        : 'Not set. Emails are discarded, which is fine locally.',
    })
  } else {
    results.push({ key: 'RESEND_API_KEY', severity: 'ok', message: 'Set.' })
    results.push(
      required(env, 'EMAIL_FROM', isProduction, 'Resend will reject every send.'),
    )
  }

  // --- Payments ----------------------------------------------------------
  /*
   * This said the app "refuses to start this way in production". It does not.
   *
   * paymentProvider() throws, and it is only called when a woman presses the
   * button that takes her money - so the container boots, the health check
   * passes, every page renders, and the ONLY broken thing is the purchase.
   * She fills in her name and her email, presses Continue to payment, and is
   * told checkout is unavailable. Nothing else on the site tells anyone.
   *
   * That wording is why this survived to be found by a customer instead of by
   * this check: it read as though the boot already protected her, which made
   * running the check look optional. It is the only thing standing between a
   * left-over default and a sale that cannot happen.
   */
  if (env.PAYMENTS_PROVIDER === 'fake') {
    results.push({
      key: 'PAYMENTS_PROVIDER',
      severity: isProduction ? 'error' : 'warning',
      message: isProduction
        ? 'Set to "fake", which approves every payment. The app will still boot and every page will work — checkout is the only thing that fails, and it fails at the moment someone tries to pay.'
        : 'Using the fake provider. No money moves.',
    })
  } else {
    const hasStripe = present(env.STRIPE_SECRET_KEY)
    results.push({
      key: 'STRIPE_SECRET_KEY',
      severity: hasStripe ? 'ok' : 'warning',
      message: hasStripe
        ? 'Set.'
        : 'Not set. Checkout will fail — fine until you are selling.',
    })
    if (hasStripe) {
      results.push({
        key: 'STRIPE_WEBHOOK_SECRET',
        severity: present(env.STRIPE_WEBHOOK_SECRET) ? 'ok' : 'error',
        message: present(env.STRIPE_WEBHOOK_SECRET)
          ? 'Set.'
          : 'Not set while Stripe IS. Every webhook will be rejected, so women will pay and get nothing.',
      })
      const key = env.STRIPE_SECRET_KEY ?? ''

      if (key.startsWith('sk_test')) {
        /*
         * An ERROR in production, not a warning.
         *
         * It used to be a warning, on the reasoning that a test key is
         * obvious because real cards decline. That is exactly backwards.
         * The person who finds out is a woman standing at a checkout with
         * her card in her hand being told it was declined - she does not
         * think "test mode", she thinks her card was refused, and she
         * leaves. Nothing appears in any log, because nothing went wrong:
         * Stripe did precisely what a test key asks for.
         *
         * Launching in test mode is the single most likely way to lose a
         * sale on day one, and it is a one-line environment variable, so it
         * gates the deploy.
         */
        results.push({
          key: 'STRIPE_SECRET_KEY',
          severity: isProduction ? 'error' : 'ok',
          message: isProduction
            ? 'This is a TEST key in production. Real cards will be DECLINED and no money will move.'
            : 'Test key, as expected.',
        })
      }

      if (key.startsWith('sk_live')) {
        /*
         * The mismatch nothing can detect.
         *
         * Stripe's webhook secrets are `whsec_...` in both modes, with
         * nothing in the string to say which. So a LIVE key paired with a
         * TEST-mode webhook secret passes every check here and is the worst
         * failure the product has: her card is really charged, the webhook
         * signature fails, fulfilment never runs, and she has paid real
         * money for nothing. It cannot be detected from the environment, so
         * it is said out loud instead.
         */
        results.push({
          key: 'STRIPE_WEBHOOK_SECRET',
          severity: 'warning',
          message:
            'Live key in use. This secret MUST come from the live-mode endpoint — a test-mode one takes real money and grants nothing, and nothing can detect it.',
        })
      }
    }
  }

  // --- Scheduled jobs ----------------------------------------------------
  results.push({
    key: 'CRON_SECRET',
    severity: present(env.CRON_SECRET) ? 'ok' : isProduction ? 'error' : 'warning',
    message: present(env.CRON_SECRET)
      ? 'Set.'
      : 'Not set, so /api/cron/automations refuses everything. No reminders will ever send.',
  })

  // --- Things that are documented but unused ------------------------------
  if (present(env.SUPABASE_SERVICE_ROLE_KEY)) {
    results.push({
      key: 'SUPABASE_SERVICE_ROLE_KEY',
      severity: 'warning',
      message:
        'Set, but nothing reads it. Remove it rather than leave a powerful key lying in the environment.',
    })
  }

  const errors = results.filter((r) => r.severity === 'error')
  const warnings = results.filter((r) => r.severity === 'warning')

  return {
    environment: isProduction ? 'production' : 'development',
    results,
    errors,
    warnings,
    ok: errors.length === 0,
  }
}
