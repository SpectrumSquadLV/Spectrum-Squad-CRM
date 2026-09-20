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
  if (env.PAYMENTS_PROVIDER === 'fake') {
    results.push({
      key: 'PAYMENTS_PROVIDER',
      severity: isProduction ? 'error' : 'warning',
      message: isProduction
        ? 'Set to "fake", which approves every payment. The app refuses to start this way in production, and so does this check.'
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
      if (present(env.STRIPE_SECRET_KEY) && env.STRIPE_SECRET_KEY.startsWith('sk_test')) {
        results.push({
          key: 'STRIPE_SECRET_KEY',
          severity: isProduction ? 'warning' : 'ok',
          message: isProduction
            ? 'This is a TEST key. No real money will move.'
            : 'Test key, as expected.',
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
