import type { i18n as I18n, PostProcessorModule, TOptions } from 'i18next'

// Pseudo-localization for the stretched-text check (v0.8.0): a string the screens take from i18next comes back with its
// letters accented, about 40% longer and between two markers, so text that does not go through the catalog (no
// markers), text cut short (one marker) and a layout that does not grow with its words show on sight. What i18next puts
// into a string (`{{name}}`, `$t(key)`) is kept as the caller gave it, and so are tags (`<kbd>`, `<0>`), entities,
// web addresses, `code` and the syntax of ICU arguments. Development and tests only: the console's entry never imports
// this file; `KUBEAST_PSEUDO_LOCALE=1 npm run dev` loads it (vite.config.ts) and `pseudo.test.ts` runs every entry.

export const PSEUDO_NAME = 'pseudo'
export const PSEUDO_START = '⟦'
export const PSEUDO_END = '⟧'
export const PSEUDO_GROWTH = 0.4
// what the padding is cut from, as Chromium's and Android's en-XA pad: plain words, so a line can break inside it
export const PSEUDO_PADDING = ' one two three four five six seven eight nine ten'.repeat(8)
// i18next passes the entry before interpolation only with postProcessPassResolved (options.i18nResolved.res)
export const PSEUDO_OPTIONS = { postProcess: [PSEUDO_NAME], postProcessPassResolved: true }

const LOWER = 'åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýž'
const UPPER = 'ÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ'
const ACCENT = new Map<string, string>()
for (let i = 0; i < 26; i++) {
  ACCENT.set(String.fromCharCode(97 + i), LOWER[i])
  ACCENT.set(String.fromCharCode(65 + i), UPPER[i])
}

export const accentLetters = (s: string): string => s.replace(/[A-Za-z]/g, (c) => ACCENT.get(c) ?? c)

type Piece = { kind: 'text' | 'keep' | 'slot'; s: string }

// interpolation (a slot: i18next replaces it) or a tag, an entity, an address or `code` (kept as written)
const PROTECTED = /\{\{[\s\S]*?\}\}|<\/?[A-Za-z0-9][\w-]*(?:\s[^<>]*)?\/?>|&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z]+);|https?:\/\/[^\s<>"'`]+|`[^`\n]*`/y
const ICU_HEAD = /\{\s*([A-Za-z_]\w*|\d+)\s*(?:,\s*([A-Za-z]+)\s*)?([},])/y
const ICU_STYLE = /[^{}]*\}/y
const ICU_OFFSET = /\s*offset:\s*\d+/y
const ICU_CASE = /\s*(=\d+|[A-Za-z_]\w*)\s*\{/y
const ICU_CLOSE = /\s*\}/y

const push = (pieces: Piece[], kind: Piece['kind'], s: string) => {
  const last = pieces[pieces.length - 1]
  if (last && last.kind === kind && kind !== 'slot') last.s += s
  else pieces.push({ kind, s })
}

const sticky = (re: RegExp, s: string, at: number): RegExpExecArray | null => {
  re.lastIndex = at
  return re.exec(s)
}

// `$t(key, { … })`: up to the parenthesis that closes it
function nestingEnd(s: string, at: number): number {
  let depth = 0
  for (let i = at + 2; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

// `{name}`, `{n, number}`, `{n, plural, one {# file} other {# files}}`: the syntax is kept and the case texts are
// pseudo text. Anything else that starts with a brace (a JSON or LogQL example) is null and reads as text.
function icu(s: string, at: number): { pieces: Piece[]; end: number } | null {
  const head = sticky(ICU_HEAD, s, at)
  if (!head) return null
  const pieces: Piece[] = []
  let i = at + head[0].length
  if (head[3] === '}') return { pieces: [{ kind: 'keep', s: head[0] }], end: i }
  const type = (head[2] ?? '').toLowerCase()
  if (!['plural', 'selectordinal', 'select'].includes(type)) {
    const style = sticky(ICU_STYLE, s, i)
    return style ? { pieces: [{ kind: 'keep', s: head[0] + style[0] }], end: i + style[0].length } : null
  }
  push(pieces, 'keep', head[0])
  const offset = sticky(ICU_OFFSET, s, i)
  if (offset) {
    push(pieces, 'keep', offset[0])
    i += offset[0].length
  }
  for (let cases = 0; ; cases++) {
    const close = sticky(ICU_CLOSE, s, i)
    if (close && cases > 0) {
      push(pieces, 'keep', close[0])
      return { pieces, end: i + close[0].length }
    }
    const kase = sticky(ICU_CASE, s, i)
    if (!kase) return null
    push(pieces, 'keep', kase[0])
    const [inner, end] = tokenize(s, i + kase[0].length, true, type !== 'select')
    if (s[end] !== '}') return null
    for (const p of inner) push(pieces, p.kind, p.s)
    push(pieces, 'keep', '}')
    i = end + 1
  }
}

function tokenize(s: string, at = 0, inCase = false, plural = false): [Piece[], number] {
  const pieces: Piece[] = []
  let i = at
  while (i < s.length) {
    if (inCase && s[i] === '}') break
    if (s.startsWith('$t(', i)) {
      const end = nestingEnd(s, i)
      if (end > 0) {
        push(pieces, 'slot', s.slice(i, end))
        i = end
        continue
      }
    }
    const kept = sticky(PROTECTED, s, i)
    if (kept) {
      push(pieces, kept[0].startsWith('{{') ? 'slot' : 'keep', kept[0])
      i += kept[0].length
      continue
    }
    if (s[i] === '{') {
      const arg = icu(s, i)
      if (arg) {
        for (const p of arg.pieces) push(pieces, p.kind, p.s)
        i = arg.end
        continue
      }
    }
    push(pieces, plural && s[i] === '#' ? 'keep' : 'text', s[i])
    i++
  }
  return [pieces, i]
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The template's slots matched against what i18next made of them: each becomes the value it was given, kept as is.
function filled(template: string, value: string): Piece[] | null {
  const [pieces] = tokenize(template)
  if (!pieces.some((p) => p.kind === 'slot')) return template === value ? pieces : null
  const match = new RegExp(`^${pieces.map((p) => (p.kind === 'slot' ? '([\\s\\S]*?)' : escapeRegExp(p.s))).join('')}$`).exec(value)
  if (!match) return null
  let n = 0
  return pieces.map((p) => (p.kind === 'slot' ? { kind: 'keep', s: match[++n] } : p))
}

export const isPseudo = (s: string): boolean => s.length >= 2 && s.startsWith(PSEUDO_START) && s.endsWith(PSEUDO_END)

// 40% of the string's own text (values, tags and the like not counted), at least two characters; none without a letter
export function paddingFor(text: string): string {
  if (!/\p{L}/u.test(text)) return ''
  return PSEUDO_PADDING.slice(0, Math.max(2, Math.ceil(text.length * PSEUDO_GROWTH))).trimEnd()
}

// `value` is what i18next made of `template`; without a template (or one it no longer matches) the whole value is read
// as text, values included.
export function pseudoLocalize(value: string, template: string = value): string {
  if (!value.trim() || isPseudo(value)) return value
  const pieces = filled(template, value) ?? tokenize(value)[0]
  const text = pieces.filter((p) => p.kind === 'text').map((p) => p.s).join('')
  const out = pieces.map((p) => (p.kind === 'text' ? accentLetters(p.s) : p.s)).join('')
  return `${PSEUDO_START}${out}${paddingFor(text)}${PSEUDO_END}`
}

type ResolvedOptions = TOptions & { i18nResolved?: { res?: unknown } }

export const pseudoPostProcessor: PostProcessorModule = {
  type: 'postProcessor',
  name: PSEUDO_NAME,
  process(value: string, _key: string | string[], options: ResolvedOptions): string {
    if (typeof value !== 'string') return value
    const entry = options.i18nResolved?.res
    const template = typeof entry === 'string' ? entry : typeof options.defaultValue === 'string' ? options.defaultValue : undefined
    // a key with no entry and no default stays bare: the check reads it as text the catalog does not hold
    if (template === undefined) return value
    return pseudoLocalize(value, template)
  },
}

// For a console already set up (src/i18n/index.ts): every string from then on is pseudo text.
export function turnOnPseudoLocale(i18n: I18n): void {
  i18n.use(pseudoPostProcessor)
  Object.assign(i18n.options, PSEUDO_OPTIONS)
}
