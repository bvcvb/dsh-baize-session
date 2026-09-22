/**
 * Validate the paths this package promises in `package.json`.
 *
 * `exports` is a contract: a `types` or `default` target that does not exist
 * ships a broken entry point that only a consumer notices — `./client` in
 * particular points at a **hand-written** declaration (`lib/types/client/`),
 * which no build step would ever create.
 *
 * Zero dependencies, run from anywhere in the repository:
 *   node scripts/check-exports.mjs
 *
 * @module dsh-baize-session/check-exports
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const problems = []

/** One declared target: must exist on disk (subpath patterns are skipped). */
function check(label, target) {
  if (typeof target !== 'string' || target.includes('*')) return
  if (!existsSync(resolve(root, target))) problems.push(`${label}: ${target} does not exist`)
}

for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value === 'string') check(`exports["${key}"]`, value)
  else for (const [condition, target] of Object.entries(value ?? {})) check(`exports["${key}"].${condition}`, target)
}
check('main', pkg.main)
check('types', pkg.types)
for (const entry of pkg.files ?? []) check('files[]', entry)
check('dsh.bundle.patch', pkg.dsh?.bundle?.patch)
// The `＋` seat and both panes are wired through the client manifest, so a
// wrong path there is a plugin that loads on the host and silently does nothing
// in the browser.
check('dsh.client (module entry)', pkg.exports?.['./client']?.default)

if (problems.length > 0) {
  console.error('package.json promises paths that do not exist:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-exports: every declared path exists (${Object.keys(pkg.exports ?? {}).length} export entries)`)
