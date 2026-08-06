import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Vitest (Vite) does not read tsconfig "paths" on its own; mirror the
    // "@/*" -> "./src/*" alias from tsconfig.json here.
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only`'s package.json exports map picks `index.js` (which
      // unconditionally throws "This module cannot be imported from a
      // Client Component...") unless the resolver is evaluating the
      // "react-server" condition, in which case it picks the empty no-op
      // `empty.js`. Next's webpack/turbopack sets that condition per
      // compilation target (RSC graph vs. client bundle) — that's the
      // mechanism the package relies on to catch a server-only module
      // reaching a client bundle. Vitest's resolver has no notion of an RSC
      // vs. client bundle (these are plain Node test runs, not a bundled
      // app), so without this alias every test that imports `@/db`,
      // `@/lib/supabase/server`, or `@/lib/auth/guards` would hit the throw
      // unconditionally. Aliasing straight to the same empty module Next
      // would select for server code is a faithful mirror of the intended
      // behavior, not a bypass: it does not run in this app's dev/build
      // pipeline, since Vitest doesn't participate in that at all — this
      // entry only affects module resolution for the test runner.
      'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Hosted Supabase tests over Supavisor session pooler routinely exceed the 5s default.
    testTimeout: 20000,
    // Parallel files cause cross-talk over the shared database connection.
    fileParallelism: false,
  },
})
