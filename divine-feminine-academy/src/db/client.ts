import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/**
 * The database client, created on first use rather than at import.
 *
 * Importing this module must not require DATABASE_URL: `next build` imports
 * every route's module graph to collect page data, so a module-scope throw
 * here fails the whole build on any machine without database credentials -
 * CI and preview deploys included. Failing at the first query instead puts
 * the error where it is actionable.
 */
function createDb() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local.',
    )
  }

  // Next.js hot-reloads modules in development, so the underlying postgres
  // client is cached on globalThis to avoid exhausting connections.
  const globalForDb = globalThis as unknown as {
    __dfaClient?: ReturnType<typeof postgres>
  }

  const client =
    globalForDb.__dfaClient ?? postgres(connectionString, { max: 10 })

  if (process.env.NODE_ENV !== 'production') {
    globalForDb.__dfaClient = client
  }

  return drizzle(client, { schema })
}

export type Db = ReturnType<typeof createDb>

let instance: Db | undefined

export function getDb(): Db {
  instance ??= createDb()
  return instance
}

/** Behaves exactly like a Drizzle client; connects on the first property access. */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, _receiver) {
    const real = getDb() as unknown as Record<string | symbol, unknown>
    const value = real[prop]
    return typeof value === 'function' ? value.bind(real) : value
  },
})
