import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import ko from './locales/ko.json'

// Every static key the UI passes to t() / tr() / i18next.t() / <Trans i18nKey> needs a Korean entry:
// without one the English default shows in the Korean UI. Kubernetes field names keep their English
// text as the Korean value on purpose (the entry is still there).

const SRC = join(process.cwd(), 'src')
const files: string[] = []
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p)
  }
}
walk(SRC)

const KEY = [/\b(?:tr|t|i18next\.t)\(\s*'([a-zA-Z]\w*\.[\w.]+)'/g, /<Trans i18nKey="([\w.]+)"/g]
const used = new Map<string, string>()
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const re of KEY) for (const m of src.matchAll(re)) if (!used.has(m[1])) used.set(m[1], relative(SRC, f))
}

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), ko)

describe('Korean catalog', () => {
  it('finds the keys the UI uses', () => {
    expect(used.size).toBeGreaterThan(1000)
  })

  it('has a Korean entry for every key the UI uses', () => {
    // a list read with returnObjects (aiChat.quickQuestions) counts as an entry
    const missing = [...used].filter(([k]) => lookup(k) === undefined || (typeof lookup(k) === 'object' && !Array.isArray(lookup(k)))).map(([k, f]) => `${k} (${f})`)
    expect(missing).toEqual([])
  })

  it('never uses a key both as a label and as the parent of other keys', () => {
    const keys = [...used.keys()]
    expect(keys.filter((k) => keys.some((o) => o.startsWith(`${k}.`)))).toEqual([])
  })
})
