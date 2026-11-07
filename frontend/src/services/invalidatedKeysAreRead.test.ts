import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A key no query reads refreshes nothing: after a save, the window it was meant to refresh goes on showing the old object.

const SRC = join(process.cwd(), 'src')
const sources: string[] = []
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) sources.push(readFileSync(p, 'utf8'))
  }
}
walk(SRC)

const INVALIDATED = /invalidateQueries\(\{\s*queryKey:\s*\[\s*'([^']+)'/g
const ACTING_ON_A_KEY = /(?:invalidate|remove|cancel|refetch|reset)Queries\(\{[^}]*\}\)/g
// The first item of a key where a query is given one or a useMemo makes one, a choice of two names counted as both.
const READ = /(?:\b\w*[kK]ey\w*\s*[:=]\s*|\(\)\s*=>\s*)\[\s*([^,\]]+)/g

const invalidated = new Set<string>()
const read = new Set<string>()
for (const src of sources) {
  for (const m of src.matchAll(INVALIDATED)) invalidated.add(m[1])
  for (const m of src.replace(ACTING_ON_A_KEY, '').matchAll(READ)) {
    for (const name of m[1].matchAll(/'([^']+)'/g)) read.add(name[1])
  }
}

describe('query keys', () => {
  it('every key a screen invalidates is one a query reads', () => {
    expect(invalidated.size).toBeGreaterThan(50)
    expect([...invalidated].filter((key) => !read.has(key)).sort()).toEqual([])
  })
})
