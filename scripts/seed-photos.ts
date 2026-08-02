/**
 * Downloads a fixed set of pickleball/court photos and uploads them into the
 * public `branch-photos` bucket, then upserts the matching `branch_photos`
 * rows.
 *
 * Photo rows are created HERE rather than in supabase/seed.sql on purpose: a
 * branch_photos row whose storage object does not exist renders as a broken
 * image, so the row is only written after the upload succeeds.
 *
 * Idempotent: `upsert: true` on the storage write, and a `where not exists`
 * guard keyed on (branch_id, storage_path) for the row (branch_photos has no
 * unique constraint on that pair, so this uses `where not exists` rather than
 * `on conflict` — do not add a constraint just for this script). Re-running
 * is a no-op.
 *
 * This script uses its own standalone `pg` Pool rather than `@/db` /
 * `src/db/index.ts`. It's a dev utility, not application code, so it has no
 * business importing anything under `src/` that's gated by `server-only` —
 * keeping the two dependency graphs separate means this script can never be
 * broken by, or break, that guard.
 *
 * Run with: npm run seed:photos
 */
import { loadEnvFile } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { Pool } from 'pg'

loadEnvFile('.env.local')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// design/branding.md, Photography: real court/gameplay photos, Unsplash free
// tier, hotlinked with ?q=70&w=<size>&auto=format&fit=crop. Prefer shots
// where the court is visible.
//
// Substitutions vs. an earlier draft of this list (verified by downloading
// and visually inspecting every URL): the draft's `photo-1613918431703-*` is
// a badminton racket/shuttlecock close-up with no court visible;
// `photo-1519861531473-*` is a basketball sitting on a basketball court —
// real court, wrong sport; `photo-1517649763962-*` is a road cycling
// peloton, no court at all. Replaced with three genuine pickleball photos
// (paddle/ball/court all visible). The remaining three (badminton indoor,
// tennis clay-court serve, tennis-court seated portrait) are real
// racket-sport court photos and reasonable stand-ins given limited
// pickleball-specific supply on Unsplash's free tier.
const SOURCES = [
  'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea',
  'https://images.unsplash.com/photo-1554068865-24cecd4e34b8',
  'https://images.unsplash.com/photo-1693142518820-78d7a05f1546',
  'https://images.unsplash.com/photo-1595435934249-5df7ed86e1c0',
  'https://images.unsplash.com/photo-1756477558468-b3e485757470',
  'https://images.unsplash.com/photo-1747027694225-cbf12dd20826',
]

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const branches = await pool.query('select id, slug from branches order by slug')
  console.log(`seeding photos for ${branches.rows.length} branches`)

  for (const [branchIndex, branch] of branches.rows.entries()) {
    const branchId = branch.id as string

    // Three photos per branch, rotating through the source list so no two
    // adjacent branches share a cover.
    for (let n = 0; n < 3; n++) {
      const source = SOURCES[(branchIndex * 3 + n) % SOURCES.length]
      const url = `${source}?q=70&w=1200&auto=format&fit=crop`
      const storagePath = `branches/${branchId}/${n + 1}.jpg`

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`failed to download ${url}: ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())

      const { error } = await supabase.storage
        .from('branch-photos')
        .upload(storagePath, bytes, { contentType: 'image/jpeg', upsert: true })
      if (error) throw error

      await pool.query(
        `insert into branch_photos (branch_id, storage_path, sort_order)
         select $1::uuid, $2, $3
         where not exists (
           select 1 from branch_photos
           where branch_id = $1::uuid and storage_path = $2
         )`,
        [branchId, storagePath, n],
      )
      console.log(`  ${branch.slug} <- ${storagePath}`)
    }
  }

  console.log('done')
  await pool.end()
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
