import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local.')
}

/**
 * One pooled client per process. Next.js hot-reloads modules in development,
 * so the client is cached on globalThis to avoid exhausting connections.
 */
const globalForDb = globalThis as unknown as {
  __dfaClient?: ReturnType<typeof postgres>
}

const client =
  globalForDb.__dfaClient ?? postgres(connectionString, { max: 10 })

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__dfaClient = client
}

export const db = drizzle(client, { schema })
export type Db = typeof db
