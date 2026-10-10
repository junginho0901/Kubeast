import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
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

  // A key built from a value (`adminRoles.catalog.permission.${key}`) is not in the list above: every
  // entry the English catalog has under such a prefix needs its Korean entry too (seven permission
  // descriptions were English in the Korean UI because of this gap).
  it('has a Korean entry for every English entry under a key built from a value', () => {
    const prefixes = new Set<string>()
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:tr|t|i18next\.t)\(\s*`([a-zA-Z][\w.]*)\.\$\{/g)) prefixes.add(m[1])
    }
    expect(prefixes.size).toBeGreaterThan(20)
    const leaves = (o: unknown, p = ''): string[] =>
      o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k)) : [p]
    const enLookup = (key: string): unknown =>
      key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), en)
    const missing: string[] = []
    for (const prefix of prefixes) {
      if (typeof lookup(prefix) !== 'object') {
        missing.push(`${prefix} (no Korean block)`)
        continue
      }
      for (const leaf of leaves(enLookup(prefix))) if (leaf && lookup(`${prefix}.${leaf}`) === undefined) missing.push(`${prefix}.${leaf}`)
    }
    expect(missing).toEqual([])
  })

  // The confirmed term table (kubeast/records/terms-pr8-20261009.md in the playground): kubernetes.io/ko terms,
  // "아니요", "삭제" for helm uninstall, empty values without parentheses, and the polite form for sentences.
  it('keeps the agreed Korean terms', () => {
    const banned = ['라벨', '수명주기', '모든 Namespace', '아니오', '언인스톨', '(없음)', '비가용', '을(를)']
    const values = (o: unknown, p = ''): [string, string][] =>
      o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => values(v, p ? `${p}.${k}` : k)) : [[p, String(o)]]
    const all = values(ko)
    expect(all.filter(([, v]) => banned.some((b) => v.includes(b))).map(([k, v]) => `${k}: ${v}`)).toEqual([])
    // a sentence ends in "…니다." — "…한다." / "…모은다." is the written-report form
    expect(all.filter(([, v]) => /[가-힣](?<![니습])다\.(\s|$)/.test(v)).map(([k, v]) => `${k}: ${v}`)).toEqual([])
  })

  it('has a Korean entry for every drawer section title', () => {
    const detail = (ko as { detail: Record<string, string> }).detail
    const missing: string[] = []
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<InfoSection\b[^>]*?\btitle="([^"]+)"/g)) {
        if (detail[`section:${m[1]}`] === undefined && detail[m[1]] === undefined) missing.push(`${m[1]} (${relative(SRC, f)})`)
      }
    }
    expect(missing).toEqual([])
  })
})
