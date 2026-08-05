import { readFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { expect, test } from 'vitest'

// `fs.promises.glob` exists at runtime on this project's Node (v22), but
// the pinned `@types/node@20.x` predates it, so a named `import { glob }`
// fails `tsc` with TS2305 even though nothing is wrong at runtime. Accessed
// via a cast on the namespace import instead of bumping @types/node (out of
// this task's scope) or hand-rolling a directory walker (which would not be
// the brief's verbatim test logic).
const glob = (fsPromises as unknown as { glob: (pattern: string) => AsyncIterable<string> }).glob

// Every guard a 'use server' file may satisfy this contract with. Extended in
// the roles-and-staff slice: `requirePlayer` (paid writes, now that roles are
// exclusive) and `requireBranchAccess` (per-branch, per-permission writes that
// staff share with owners). `requireOwner`/`requireOwnerOf` cover owner-only
// actions; requireOwnerOf is already listed and is what the staff-management
// actions use.
const GUARDS = [
  'requireUser',
  'requireAdmin',
  'requireOwnerOf',
  'requireOwner',
  'requirePlayer',
  'requireBranchAccess',
]

test('every file with "use server" calls an authorization guard', async () => {
  const unguarded: string[] = []

  // Final whole-branch review, ALSO FIX #8: this test's own stated contract
  // is "every file with 'use server'", but a `.tsx` Server Action (e.g. one
  // colocated with a client component) would previously escape it entirely
  // — `src/**/*.ts` does not match `.tsx`. Widened to `src/**/*.{ts,tsx}` so
  // the glob actually matches its contract instead of a subset of it.
  for await (const file of glob('src/**/*.{ts,tsx}')) {
    const source = await readFile(file, 'utf8')
    if (!/^\s*['"]use server['"]/m.test(source)) continue
    if (!GUARDS.some((guard) => source.includes(guard))) unguarded.push(file)
  }

  expect(unguarded, `these Server Action files call no guard: ${unguarded.join(', ')}`).toEqual([])
})
