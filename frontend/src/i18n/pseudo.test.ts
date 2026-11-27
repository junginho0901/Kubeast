import i18next, { type ResourceKey } from 'i18next'
import { describe, expect, it } from 'vitest'
import { translateDetailSection } from '../components/resource-detail/detailLabel'
import en from './locales/en.json'
import ko from './locales/ko.json'
import { PSEUDO_END, PSEUDO_OPTIONS, PSEUDO_PADDING, PSEUDO_START, pseudoLocalize, pseudoPostProcessor } from './pseudo'

type Catalog = { [key: string]: ResourceKey }

const LOWER = 'åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýž'
const UPPER = 'ÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ'
const plainLetter = new Map<string, string>([...LOWER].map((c, i) => [c, String.fromCharCode(97 + i)]))
for (const [i, c] of [...UPPER].entries()) plainLetter.set(c, String.fromCharCode(65 + i))
const unaccent = (s: string) => [...s].map((c) => plainLetter.get(c) ?? c).join('')

// i18next set up as src/i18n/index.ts sets it up (no detector), with the pseudo text on
async function pseudoI18n(resources: Record<string, Catalog>): Promise<typeof i18next> {
  const i18n = i18next.createInstance()
  await i18n.use(pseudoPostProcessor).init({
    resources: Object.fromEntries(Object.entries(resources).map(([lng, cat]) => [lng, { translation: cat, detail: lng === 'ko' ? ko.detail : {} }])),
    ns: ['translation', 'detail'],
    defaultNS: 'translation',
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    ...PSEUDO_OPTIONS,
  })
  return i18n
}

const SLOT = /\{\{\s*-?\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g
const TAG = /<\/?[A-Za-z0-9][\w-]*(?:\s[^<>]*)?\/?>/g
const ADDRESS = /https?:\/\/[^\s<>"'`]+/g

describe('pseudo text', () => {
  it('accents each letter, grows by 40% of the text and puts a marker at each end', () => {
    expect(pseudoLocalize('Delete pod')).toBe('⟦Ðéļéţé þöð one⟧')
    expect(pseudoLocalize('OK')).toBe('⟦ÖĶ o⟧')
    expect(pseudoLocalize('Show logs of the selected container')).toBe('⟦Šĥöŵ ļöĝš öƒ ţĥé šéļéçţéð çöñţåîñéŕ one two three⟧')
  })

  it('leaves an empty string, white space and text that is already pseudo text as they are', () => {
    expect(pseudoLocalize('')).toBe('')
    expect(pseudoLocalize('  ')).toBe('  ')
    expect(pseudoLocalize(pseudoLocalize('Delete pod'))).toBe('⟦Ðéļéţé þöð one⟧')
  })

  it("keeps a value, a tag, an address and code as the caller wrote them", async () => {
    const i18n = await pseudoI18n({ en: {
      ask: 'Delete pod <kbd>{{name}}</kbd>?',
      raw: 'Value: {{- value}} and {{n, number}}',
      docs: 'See https://kubernetes.io/docs/ and run `kubectl get pods`',
      entity: 'Tom&nbsp;and&#160;Jerry',
    } })
    expect(i18n.t('ask', { name: 'nginx-web' })).toBe('⟦Ðéļéţé þöð <kbd>nginx-web</kbd>? one⟧')
    expect(i18n.t('raw', { value: 'abc<b>', n: 3 })).toBe('⟦Ṽåļûé: abc<b> åñð 3 one⟧')
    expect(i18n.t('docs')).toBe('⟦Šéé https://kubernetes.io/docs/ åñð ŕûñ `kubectl get pods` one t⟧')
    expect(i18n.t('entity')).toBe('⟦Ţöɱ&nbsp;åñð&#160;Ĵéŕŕý one⟧')
  })

  it('keeps a nested entry as i18next wrote it in', async () => {
    const i18n = await pseudoI18n({ en: { open: 'Open $t(thePod) now', thePod: 'the pod' } })
    expect(i18n.t('open')).toBe('⟦Öþéñ the pod ñöŵ one⟧')
  })

  it('takes the plural entry i18next picked and keeps the count', async () => {
    const i18n = await pseudoI18n({ en: { files_one: '{{count}} file', files: '{{count}} files' }, ko: { files: '파일 {{count}}개' } })
    expect(i18n.t('files', { count: 1 })).toBe('⟦1 ƒîļé o⟧')
    expect(i18n.t('files', { count: 12 })).toBe('⟦12 ƒîļéš on⟧')
    expect(i18n.t('files', { count: 12, lng: 'ko' })).toBe('⟦파일 12개 o⟧')
  })

  it("keeps an ICU argument's syntax and pseudo-localizes its cases", () => {
    expect(pseudoLocalize('{n, plural, one {# file} other {# files}}')).toBe('⟦{n, plural, one {# ƒîļé} other {# ƒîļéš}} one⟧')
    expect(pseudoLocalize('{n, plural, offset:1 =0 {nobody} other {{name} and # more}}')).toBe(
      '⟦{n, plural, offset:1 =0 {ñöƀöðý} other {{name} åñð # ɱöŕé}} one tw⟧',
    )
    expect(pseudoLocalize('Hi {name}, at {when, date, short}')).toBe('⟦Ĥî {name}, åţ {when, date, short} one⟧')
    expect(pseudoLocalize('{kind, select, pod {Pod} other {Object}}')).toBe('⟦{kind, select, pod {Þöð} other {Öƀĵéçţ}} one⟧')
  })

  it('reads a brace that starts no ICU argument as text', () => {
    expect(pseudoLocalize('e.g. {"temperature": 0.7}')).toBe('⟦é.ĝ. {"ţéɱþéŕåţûŕé": 0.7} one two t⟧')
    expect(pseudoLocalize('{} |= "error"')).toBe('⟦{} |= "éŕŕöŕ" one t⟧')
  })

  it('leaves a key with no entry and no default bare and marks a default', async () => {
    const i18n = await pseudoI18n({ en: {} })
    expect(i18n.t('nowhere.key')).toBe('nowhere.key')
    expect(i18n.t('nowhere.key', 'Not found')).toBe('⟦Ñöţ ƒöûñð one⟧')
  })

  it('marks a drawer section title once when it falls back to its label', async () => {
    const i18n = await pseudoI18n({ en, ko })
    const t = i18n.getFixedT('en')
    expect(translateDetailSection(t, 'Used By Pods ({{n}})', { n: 4 })).toBe('⟦Ûšéð Ɓý Þöðš (4) one t⟧')
    const tKo = i18n.getFixedT('ko')
    const ko1 = translateDetailSection(tKo, 'Selector')
    expect([ko1.startsWith(PSEUDO_START), ko1.indexOf(PSEUDO_START, 1), ko1.endsWith(PSEUDO_END)]).toEqual([true, -1, true])
  })

  it('pseudo-localizes each line of a list read whole', async () => {
    const i18n = await pseudoI18n({ en, ko })
    const lines = i18n.t('aiChat.quickQuestions', { returnObjects: true }) as unknown as string[]
    expect(lines.map((l) => [l.startsWith(PSEUDO_START), l.endsWith(PSEUDO_END)])).toEqual((en.aiChat.quickQuestions as string[]).map(() => [true, true]))
  })
})

// Every entry of both catalogs, through i18next as the screens call it: a value for each placeholder (its plural form
// by the count), then held to the same call without the pseudo text.
describe('pseudo text of every catalog entry', () => {
  type Entry = { lng: 'en' | 'ko'; ns: 'translation' | 'detail'; key: string; raw: string }
  const entries: Entry[] = []
  const walk = (lng: Entry['lng'], o: unknown, path: string[]) => {
    if (typeof o === 'string') entries.push({ lng, ns: 'translation', key: path.join('.'), raw: o })
    else if (Array.isArray(o)) o.forEach((v, i) => walk(lng, v, [...path, String(i)]))
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (!(lng === 'ko' && path.length === 0 && k === 'detail')) walk(lng, v, [...path, k])
  }
  walk('en', en, [])
  walk('ko', ko, [])
  for (const [key, raw] of Object.entries((ko as { detail: Record<string, string> }).detail)) {
    entries.push({ lng: 'ko', ns: 'detail', key, raw })
    entries.push({ lng: 'en', ns: 'detail', key, raw: key }) // English has no detail entries: the label is the default
  }

  const PLURAL: Record<string, number> = { zero: 0, one: 1, two: 2, few: 3, many: 11, other: 7 }
  const call = (e: Entry) => {
    const plural = e.ns === 'translation' ? /_(zero|one|two|few|many|other)$/.exec(e.key) : null
    const values: Record<string, string | number> = {}
    for (const m of e.raw.matchAll(SLOT)) values[m[1]] = m[1] === 'count' ? 7 : `[[${m[1]}-value]]`
    if (plural) values.count = PLURAL[plural[1]]
    const key = plural ? e.key.slice(0, -plural[0].length) : e.key
    const options = e.ns === 'detail' ? { ns: 'detail', keySeparator: false as const, nsSeparator: false as const, defaultValue: e.key } : {}
    return { key, values, options: { ...options, ...values, lng: e.lng } }
  }

  it('finds the entries', () => {
    expect(entries.length).toBeGreaterThan(9000)
  })

  it('keeps every value, tag and address and only accents the letters around them', async () => {
    const i18n = await pseudoI18n({ en, ko })
    const bad: string[] = []
    let plainLength = 0
    let pseudoLength = 0
    for (const e of entries) {
      const { key, values, options } = call(e)
      const plain = i18n.t(key, { ...options, applyPostProcessor: false }) as string
      const pseudo = i18n.t(key, options) as string
      const where = `${e.lng} ${e.ns} ${e.key}`
      // the call reached this entry: what i18next made is the entry with the values put in
      const expected = e.raw.replace(SLOT, (_, name: string) => String(values[name]))
      if (plain !== expected) {
        bad.push(`${where}: resolved to ${JSON.stringify(plain)}`)
        continue
      }
      if (!plain.trim()) {
        if (pseudo !== plain) bad.push(`${where}: blank entry changed`)
        continue
      }
      if (!pseudo.startsWith(PSEUDO_START) || !pseudo.endsWith(PSEUDO_END)) {
        bad.push(`${where}: markers missing in ${JSON.stringify(pseudo)}`)
        continue
      }
      const inner = pseudo.slice(PSEUDO_START.length, -PSEUDO_END.length)
      const body = inner.slice(0, plain.length)
      const padding = inner.slice(plain.length)
      if (unaccent(body) !== unaccent(plain)) bad.push(`${where}: text changed to ${JSON.stringify(pseudo)}`)
      if (!PSEUDO_PADDING.startsWith(padding)) bad.push(`${where}: padding ${JSON.stringify(padding)}`)
      for (const m of e.raw.matchAll(SLOT)) if (!pseudo.includes(String(values[m[1]]))) bad.push(`${where}: value of ${m[1]} not kept`)
      for (const re of [TAG, ADDRESS]) {
        const before = plain.match(re) ?? []
        const after = body.match(re) ?? []
        if (JSON.stringify(before) !== JSON.stringify(after)) bad.push(`${where}: ${JSON.stringify(before)} became ${JSON.stringify(after)}`)
      }
      if (e.lng === 'en' && Object.keys(values).length === 0) {
        plainLength += plain.length
        pseudoLength += inner.length
      }
    }
    expect(bad).toEqual([])
    // the English entries with no value in them, all together: about 40% longer
    const growth = pseudoLength / plainLength
    expect(growth).toBeGreaterThanOrEqual(1.35)
    expect(growth).toBeLessThanOrEqual(1.45)
  })

  it('accents the letters of every English entry that has text of its own', async () => {
    const i18n = await pseudoI18n({ en, ko })
    const unchanged = entries
      .filter((e) => e.lng === 'en' && /[A-Za-z]/.test(e.raw.replace(SLOT, '').replace(TAG, '').replace(ADDRESS, '').replace(/`[^`\n]*`/g, '')))
      .filter((e) => {
        const { key, options } = call(e)
        const pseudo = i18n.t(key, options) as string
        return !/[åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ]/.test(pseudo)
      })
      .map((e) => e.key)
    expect(unchanged).toEqual([])
  })
})
