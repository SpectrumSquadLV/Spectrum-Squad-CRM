import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * Health, for uptime monitoring and for confirming a deploy actually works.
 *
 * Deliberately says almost nothing: up or down, and whether the database
 * answers. A health endpoint that lists versions, configuration or migration
 * state is a free reconnaissance report for anybody who finds it.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await db.execute(sql`select 1`)
    return NextResponse.json(
      { status: 'ok' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch {
    return NextResponse.json(
      { status: 'degraded' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
