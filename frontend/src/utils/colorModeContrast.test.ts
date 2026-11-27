import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The warning and notice bands are read in all three colour modes from the tokens of index.css over Tailwind's
// palette, with no browser: axe-core over the screens (screen-consistency.spec.ts) never sees them, since each shows
// only in a state no screen is opened in (a refusal, a stopped live list, a past sign-off, a cut list). In light the
// hue shades 200-400 and 800-950 turn over and 50-100 stay, so a band written in a 100 on its 900 tint read 1.02:1
// there. Text is held to WCAG 2.2's 4.5:1 (an icon would need 3:1; the bands' icons are held to 4.5 too).

const SRC = join(process.cwd(), 'src')
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8')
const THEME_CSS = readFileSync(join(process.cwd(), 'node_modules/tailwindcss/theme.css'), 'utf8')
const MODES = ['default', 'dark', 'light'] as const
type Mode = (typeof MODES)[number]

// ---- index.css: each block's selector and its --color-* declarations ----

type Block = { selectors: string[]; decls: [string, string][] }

function cssBlocks(source: string): Block[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const out: Block[] = []
  const stack: { prelude: string; decls: [string, string][] }[] = []
  let buf = ''
  let quote = ''
  let paren = 0
  for (const ch of css) {
    if (quote) {
      buf += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') paren++
    else if (ch === ')') paren--
    if (paren > 0 || quote) {
      buf += ch
      continue
    }
    if (ch === '{') {
      stack.push({ prelude: buf.trim(), decls: [] })
      buf = ''
    } else if (ch === ';' || ch === '}') {
      const at = buf.indexOf(':')
      const name = buf.slice(0, at).trim()
      if (at > 0 && name.startsWith('--color-') && stack.length) stack[stack.length - 1].decls.push([name, buf.slice(at + 1).trim()])
      buf = ''
      if (ch === '}') {
        const b = stack.pop()
        if (b) out.push({ selectors: b.prelude.split(/,(?![^(]*\))/).map((s) => s.trim().replace(/\s+/g, ' ')), decls: b.decls })
      }
    } else buf += ch
  }
  return out
}

const THEME_BLOCKS = cssBlocks(THEME_CSS)
const INDEX_BLOCKS = cssBlocks(INDEX_CSS)
const SIGN_IN = "[data-color-mode='default']"

// The colour variables an element reads in a mode: Tailwind's palette, @theme, the root blocks in source order; on
// the sign-in pages the element blocks of data-color-mode="default" over those.
function colourVars(mode: Mode, signIn = false): Map<string, string> {
  const vars = new Map<string, string>()
  for (const b of [...THEME_BLOCKS, ...INDEX_BLOCKS]) if (b.selectors[0].startsWith('@theme')) for (const [k, v] of b.decls) vars.set(k, v)
  for (const b of INDEX_BLOCKS) {
    if (b.selectors.includes(':root') || b.selectors.includes(`:root[data-color-mode='${mode}']`)) for (const [k, v] of b.decls) vars.set(k, v)
  }
  if (signIn) for (const b of INDEX_BLOCKS) if (b.selectors.includes(SIGN_IN)) for (const [k, v] of b.decls) vars.set(k, v)
  return vars
}

// ---- colours: sRGB 0..1 with an alpha ----

type RGBA = { r: number; g: number; b: number; a: number }
const clamp = (x: number) => Math.min(1, Math.max(0, x))

// oklch -> OKLab -> linear sRGB -> sRGB, clipped (CSS Color 4's matrices)
function oklch(L: number, C: number, H: number): RGBA {
  const h = (H * Math.PI) / 180
  const [A, B] = [C * Math.cos(h), C * Math.sin(h)]
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const enc = (v: number) => (clamp(v) <= 0.0031308 ? 12.92 * clamp(v) : 1.055 * clamp(v) ** (1 / 2.4) - 0.055)
  return {
    r: enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: 1,
  }
}

function parseColour(value: string, vars: Map<string, string>): RGBA {
  const v = value.trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) return parseColour(vars.get(ref[1]) ?? '', vars)
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: 1 }
  }
  const ok = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/.exec(v)
  if (ok) return oklch(Number(ok[1]) / 100, Number(ok[2]), Number(ok[3]))
  throw new Error(`a colour this test does not read: "${v}"`)
}

// "amber-900/20", "slate-800", "#020617"
function tokenColour(spec: string, vars: Map<string, string>): RGBA {
  if (spec.startsWith('#')) return parseColour(spec, vars)
  const [name, pct] = spec.split('/')
  const value = vars.get(`--color-${name}`)
  if (value === undefined) throw new Error(`no token ${name}`)
  const c = parseColour(value, vars)
  return pct ? { ...c, a: Number(pct) / 100 } : c
}

const over = (top: RGBA, under: RGBA): RGBA => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
})

// WCAG 2.2 relative luminance and contrast, never rounded up
function luminance(c: RGBA): number {
  const ch = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}
const cut = (x: number) => Math.floor(x * 100) / 100

// text over a stack of grounds, the first opaque
function contrast(text: string, ground: string[], vars: Map<string, string>): number {
  const bg = ground.slice(1).reduce((under, layer) => over(tokenColour(layer, vars), under), tokenColour(ground[0], vars))
  const fg = over(tokenColour(text, vars), bg)
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return cut((hi + 0.05) / (lo + 0.05))
}

// ---- the source: an element, the colour classes of its tags ----

const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
// a notice or badge role (index.css @theme inline) is read as the mode's step it names
const COLOUR = String.raw`(?:ink|white|black|primary-bright|(?:slate|gray|primary|${HUES})-(?:50|[1-9]00|950)|(?:notice|badge)(?:-[a-z]+)+)(?:/\d{1,3})?`
// a class with no variant before it (hover:, dark:), as the element shows at rest
const classesOf = (tag: string, kind: 'text' | 'bg') =>
  [...tag.matchAll(new RegExp(String.raw`(?<![\w:/-])${kind}-(${COLOUR})(?![\w-])`, 'g'))].map((m) => m[1])

// the opening tag at `at`: up to the first > outside braces
function openingTag(src: string, at: number): string {
  let depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(at, i + 1)
  }
  return src.slice(at)
}

// the element whose opening tag holds the text at `at`, as the opening tags of it and of every element inside it
function elementTags(src: string, at: number): string[] {
  const start = src.lastIndexOf('<', at)
  const name = /^<([A-Za-z][\w.]*)/.exec(src.slice(start))?.[1]
  if (!name) throw new Error(`no element around ${src.slice(at, at + 40)}`)
  const open = openingTag(src, start)
  if (open.endsWith('/>')) return [open]
  const body = start + open.length
  const close = new RegExp(String.raw`<${name}\b|</${name}>`, 'g')
  close.lastIndex = body
  let depth = 1
  let end = src.length
  for (let m = close.exec(src); m; m = close.exec(src)) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) {
        end = m.index
        break
      }
    } else if (!openingTag(src, m.index).endsWith('/>')) depth++
  }
  const inner = [...src.slice(body, end).matchAll(/<[A-Za-z][\w.]*\b/g)].map((m) => openingTag(src, body + m.index))
  return [open, ...inner]
}

type Place = { file: string; at: string; on: string[][] }

const PAGE = [['slate-900'], ['slate-800']]
// the pending-requests count sits on the sidebar or a tab, on the selected item and on a primary button
const COUNT = [['slate-800'], ['slate-900'], ['primary-600']]
const PLACES: Place[] = [
  { file: 'components/ForbiddenBanner.tsx', at: 'data-testid="forbidden-banner"', on: PAGE },
  { file: 'components/WatchProblemNotice.tsx', at: 'data-testid="watch-problem-notice"', on: PAGE },
  { file: 'pages/custom-resources/CustomResourceInstances.tsx', at: 'data-testid="cr-instances-notice"', on: PAGE },
  { file: 'pages/admin/AccessReview.tsx', at: 'data-testid="access-review-snapshot-banner"', on: PAGE },
  { file: 'pages/admin/ClusterHygiene.tsx', at: 'data-testid="hygiene-snapshot-banner"', on: PAGE },
  { file: 'pages/admin/ClusterHygiene.tsx', at: 'data-testid="hygiene-collectors"', on: PAGE },
  { file: 'pages/admin/ClusterHygiene.tsx', at: 'data-testid="hygiene-truncated"', on: PAGE },
  { file: 'pages/ResourceGraph.tsx', at: 'data-testid="resource-graph-forbidden"', on: PAGE },
  { file: 'components/Layout.tsx', at: 'bg-badge-surface-pending', on: COUNT },
  { file: 'pages/admin/AccessRequests.tsx', at: 'bg-badge-surface-pending', on: COUNT },
  { file: 'pages/AdminUsers.tsx', at: 'bg-badge-surface-pending', on: COUNT },
  { file: 'components/LogSearchView.tsx', at: '<mark ', on: [['slate-900'], ['slate-950']] },
  // the class that is the current one among the conflicting PriorityClasses, inside its amber box
  { file: 'components/resource-detail/PriorityClassInfo.tsx', at: 'bg-amber-800/30', on: [['slate-800', 'amber-900/20'], ['slate-900', 'amber-900/20']] },
]

// every text colour of the element on what it sits on: the element's own grounds, and an inner tag's own ground over
// those; a tag that holds two grounds (a choice in its class) is read on each
function pairsOf(place: Place): { text: string; ground: string[] }[] {
  const src = readFileSync(join(SRC, place.file), 'utf8')
  const at = src.indexOf(place.at)
  if (at < 0) throw new Error(`${place.file}: no ${place.at}`)
  const [own, ...inner] = elementTags(src, at)
  const layer = (grounds: string[][], tag: string) => {
    const bgs = classesOf(tag, 'bg')
    return bgs.length ? grounds.flatMap((g) => bgs.map((bg) => [...g, bg])) : grounds
  }
  const grounds = layer(place.on, own)
  const pairs = classesOf(own, 'text').flatMap((text) => grounds.map((ground) => ({ text, ground })))
  for (const tag of inner) {
    const here = layer(grounds, tag)
    pairs.push(...classesOf(tag, 'text').flatMap((text) => here.map((ground) => ({ text, ground }))))
  }
  return pairs
}

describe('colour mode contrast of the notice bands', () => {
  it('reads the band a light 100 on its 900 tint was as it showed (1.02:1 in light)', () => {
    const band = ['slate-900', 'amber-900/20']
    expect(MODES.map((mode) => contrast('amber-100', band, colourVars(mode)))).toEqual([15.57, 15.09, 1.02])
  })

  it.each(PLACES.map((p): [string, Place] => [`${p.file} ${p.at}`, p]))('%s keeps its text at 4.5:1 in every mode', (_name, place) => {
    const pairs = pairsOf(place)
    expect(pairs.length).toBeGreaterThan(0)
    const under = MODES.flatMap((mode) => {
      const vars = colourVars(mode)
      return pairs
        .map(({ text, ground }) => ({ mode, text, ground: ground.join(' + '), ratio: contrast(text, ground, vars) }))
        .filter((p) => p.ratio < 4.5)
    })
    expect(under).toEqual([])
  })

  it('the sign-in pages read the brand palette in every mode', () => {
    // The sign-in pages keep the complete brand palette over every console mode, including borders and controls.
    const brand = colourVars('default', true)
    for (const mode of MODES) {
      const differ = [...colourVars(mode, true)].filter(([k, v]) => brand.get(k) !== v).map(([k]) => k)
      expect({ mode, differ }).toEqual({ mode, differ: [] })
    }
  })

  it('no console text is written in a step light leaves light or turns into a ground', () => {
    // the sign-in pages keep the default mode, so a pale step there stays on navy
    const signIn = ['pages/Login.tsx', 'pages/Setup.tsx', 'pages/setup/', 'components/PendingApproval.tsx', 'components/login/']
    const pale = new RegExp(String.raw`(?<![\w/-])(?:[\w-]+:)*text-(?:${HUES}|primary)-(?:50|100)(?![\w-])`)
    // slate and gray 800-950 are the grounds in light; a line that sets its text again under dark: is read as that
    const ground = /(?<![\w:/-])text-(?:slate|gray)-(?:800|900|950)(?![\w-])/
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      )
    const found: string[] = []
    for (const file of files(SRC)) {
      const name = relative(SRC, file)
      if (signIn.some((s) => name.startsWith(s))) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (pale.test(line) || (ground.test(line) && !line.includes('dark:text-'))) found.push(`${name}:${i + 1}`)
        })
    }
    expect(found).toEqual([])
  })
})
