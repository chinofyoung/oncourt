import { loadEnvFile } from 'node:process'
import { afterAll } from 'vitest'

loadEnvFile('.env.local')

// Global per-file teardown for tests/helpers/fixtures.ts (final whole-branch
// review, MUST FIX #3 — see that module's teardownFixtures() doc comment for
// the full FK-ordering rationale). Loaded with a *dynamic* import, not a
// top-level one: fixtures.ts imports '@/db', and src/db/index.ts throws at
// module-evaluation time if DATABASE_URL isn't set yet. ESM hoists top-level
// imports above this file's own body, so a top-level import here would
// evaluate '@/db' before the loadEnvFile() call above ever runs. The dynamic
// import below only runs inside the afterAll callback, long after
// loadEnvFile() has already populated process.env.DATABASE_URL — and Vitest
// caches ES modules per test file, so this resolves to the exact same
// fixtures.ts instance a test file's own `import { seedPlayer } from
// '../helpers/fixtures'` got, sharing its tracked-id state.
//
// A no-op for test files that never import tests/helpers/fixtures.ts —
// teardownFixtures() returns immediately when nothing was tracked.
afterAll(async () => {
  const { teardownFixtures } = await import('./helpers/fixtures')
  await teardownFixtures()
})
