#!/usr/bin/env node
// Token pair contrast: the colour pairs the console uses, read from its colour tokens in every colour mode and held
// to WCAG 2.2 — 4.5:1 for text (SC 1.4.3), 3:1 for large text and for what one needs to see of a control or a graphic
// (SC 1.4.11). No browser: values come from frontend/src/index.css (the colour-mode blocks over @theme) and
// Tailwind's own palette (node_modules/tailwindcss/theme.css); the pairs from token-pairs.json and DESIGN.md.
//
//   npm run check:contrast -- [options]     (in frontend; node scripts/token-contrast.mjs is the same)
//   options: [--frontend <dir>] [--theme <theme.css>] [--pairs <file>] [--design <DESIGN.md>]
//            [--used] [--matrix] [--modes default,dark,light] [--strict] [--json <out>]
//
//   --used    also the pairs a class string writes itself (one text-* colour and one bg-* colour in the same string,
//             no variant prefix), from frontend/src — read only, never failing the run
//   --matrix  every text step on every surface step, read only (adds the sign-in pages' own palette, "brand")
//   --strict  exit 1 when a pair of token-pairs.json or of DESIGN.md's components is under its line, or when DESIGN.md's
//             colour-mode table names a hex that index.css does not set
//
// Ratios are never rounded up (Understanding 1.4.3: 4.499:1 does not meet 4.5:1); they print cut to two decimals.
// oklch is turned into sRGB and clipped to it; a browser may map a colour outside sRGB another way, so a pair that
// passes by less than 0.2 is marked "near" — axe-core's color-contrast over the screens (screen-consistency) reads it
// again as drawn. A colour with an opacity modifier (red-900/20) is laid over the colour under it in sRGB.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NEED = { text: 4.5, large: 3, nontext: 3, decorative: null }
const NEAR = 0.2
const MODES = ['default', 'dark', 'light']

function args(argv) {
  const out = { modes: MODES }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => argv[++i]
    if (a === '--frontend') out.frontend = value()
    else if (a === '--theme') out.theme = value()
    else if (a === '--pairs') out.pairs = value()
    else if (a === '--design') out.design = value()
    else if (a === '--json') out.json = value()
    else if (a === '--modes') out.modes = value().split(',')
    else if (a === '--used') out.used = true
    else if (a === '--matrix') out.matrix = true
    else if (a === '--strict') out.strict = true
    else throw new Error(`unknown argument ${a}`)
  }
  out.frontend ??= join(HERE, '..')
  out.theme ??= join(out.frontend, 'node_modules', 'tailwindcss', 'theme.css')
  out.pairs ??= join(HERE, 'token-pairs.json')
  out.design ??= join(out.frontend, '..', 'DESIGN.md')
  return out
}

// ---- CSS: blocks and their declarations, comments blanked so offsets and lines stay ----

export function parseBlocks(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const blocks = []
  const stack = []
  let buf = ''
  let quote = ''
  let paren = 0
  for (const ch of css) {
    if (quote) {
      buf += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue }
    if (ch === '(') paren += 1
    if (ch === ')') paren -= 1
    if (paren > 0) { buf += ch; continue }
    if (ch === '{') { stack.push({ prelude: buf.trim().replace(/\s+/g, ' '), decls: [] }); buf = ''; continue }
    if (ch === ';' || ch === '}') {
      if (buf.trim() && stack.length) stack[stack.length - 1].decls.push(buf.trim())
      buf = ''
      if (ch === '}') {
        const b = stack.pop()
        if (b) blocks.push({ preludes: [...stack.map((s) => s.prelude), b.prelude], decls: b.decls })
      }
      continue
    }
    buf += ch
  }
  return blocks
}

function colourDecls(block) {
  const out = []
  for (const d of block.decls) {
    const at = d.indexOf(':')
    if (at < 0) continue
    const name = d.slice(0, at).trim()
    if (name.startsWith('--color-')) out.push([name, d.slice(at + 1).trim()])
  }
  return out
}

// selectors of one prelude, split at top-level commas, one space for any run of white space, double quotes as single
function selectors(prelude) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of prelude) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim().replace(/\s+/g, ' ').replace(/"/g, "'"))
}

const ROOT_ALL = ':root'
const ROOT_DEFAULT = [":root:not([data-color-mode])", ":root[data-color-mode='default']"]
const ELEMENT_DEFAULT = "[data-color-mode='default']"
const rootMode = (m) => `:root[data-color-mode='${m}']`

// The colour variables in force for one mode: Tailwind's palette, index.css @theme, then the mode blocks in source order.
export function modeVars(themeCss, indexCss, mode) {
  const vars = new Map()
  for (const b of parseBlocks(themeCss)) if (b.preludes[b.preludes.length - 1].startsWith('@theme')) for (const [k, v] of colourDecls(b)) vars.set(k, v)
  const blocks = parseBlocks(indexCss)
  for (const b of blocks) if (b.preludes[b.preludes.length - 1].startsWith('@theme')) for (const [k, v] of colourDecls(b)) vars.set(k, v)
  const fills = { classes: new Set(), decls: [] }
  const matchesRoot = (sel) => {
    if (sel === ROOT_ALL) return true
    if (mode === 'default' || mode === 'brand') return ROOT_DEFAULT.includes(sel)
    return sel === rootMode(mode)
  }
  for (const b of blocks) {
    const sels = selectors(b.preludes[b.preludes.length - 1])
    if (sels.some(matchesRoot)) for (const [k, v] of colourDecls(b)) vars.set(k, v)
    // light: "inside a filled colour ink is white again" — kept apart, used when a pair's ground is one of those fills
    for (const s of sels) {
      const m = s.match(/^:root\[data-color-mode='(\w+)'\] :is\((.*)\)$/)
      if (m && m[1] === mode) {
        for (const c of m[2].split(',')) fills.classes.add(c.trim().replace(/^\./, ''))
        fills.decls.push(...colourDecls(b))
      }
    }
  }
  // the sign-in pages: an element with data-color-mode="default" under the console's root takes the brand ladder back
  if (mode === 'brand') for (const b of blocks) if (selectors(b.preludes[b.preludes.length - 1]).includes(ELEMENT_DEFAULT)) for (const [k, v] of colourDecls(b)) vars.set(k, v)
  return { vars, fills }
}

// ---- colours ----

const clamp = (x) => Math.min(1, Math.max(0, x))

function hex(s) {
  let h = s.slice(1)
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1, clipped: false }
}

function number(token, scale) {
  if (token.endsWith('%')) return (parseFloat(token) / 100) * scale
  return parseFloat(token)
}

function alphaOf(token) {
  if (token === undefined) return 1
  return token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token)
}

// oklch -> OKLab -> linear sRGB -> sRGB (Bjorn Ottosson's matrices, the ones CSS Color 4 uses)
function oklch(L, C, H, a) {
  const h = (H * Math.PI) / 180
  const A = C * Math.cos(h)
  const B = C * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const clipped = lin.some((v) => v < -0.001 || v > 1.001)
  const enc = (v) => {
    const x = clamp(v)
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  }
  return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a, clipped }
}

export function parseColour(value, vars, seen = new Set()) {
  const v = value.trim()
  const ref = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/)
  if (ref) {
    if (seen.has(ref[1])) throw new Error(`a loop of variables at ${ref[1]}`)
    if (vars.has(ref[1])) return parseColour(vars.get(ref[1]), vars, new Set([...seen, ref[1]]))
    if (ref[2]) return parseColour(ref[2], vars, seen)
    throw new Error(`no ${ref[1]}`)
  }
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return hex(v)
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0, clipped: false }
  const fn = v.match(/^(oklch|rgba?)\(\s*([^)]*)\)$/i)
  if (fn) {
    const [body, alpha] = fn[2].split('/').map((x) => x.trim())
    const parts = body.split(/[\s,]+/).filter(Boolean)
    if (fn[1].toLowerCase() === 'oklch') return oklch(number(parts[0], 1), number(parts[1], 0.4), parseFloat(parts[2]) || 0, alphaOf(alpha))
    const a = alpha ?? parts[3]
    return { r: clamp(number(parts[0], 255) / 255), g: clamp(number(parts[1], 255) / 255), b: clamp(number(parts[2], 255) / 255), a: alphaOf(a), clipped: false }
  }
  throw new Error(`a colour this script does not read: ${v}`)
}

// "slate-800", "red-900/20", "ink/87", "#020617" — a token name, an opacity in percent, or a literal
export function tokenColour(spec, vars) {
  if (spec.startsWith('#')) return hex(spec)
  const [name, pct] = spec.split('/')
  const key = `--color-${name}`
  if (!vars.has(key)) throw new Error(`no token ${name}`)
  const c = parseColour(vars.get(key), vars)
  return pct ? { ...c, a: c.a * (Number(pct) / 100) } : c
}

const over = (top, under) => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
  clipped: top.clipped || under.clipped,
})

// WCAG 2.2 relative luminance (the 0.04045 of the current definition)
function luminance(c) {
  const ch = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

export function ratio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

const toHex = (c) => `#${[c.r, c.g, c.b].map((x) => Math.round(clamp(x) * 255).toString(16).padStart(2, '0')).join('')}`
const cut = (x) => Math.floor(x * 100) / 100

// One pair in one mode. bg is the stack under the foreground, opaque first.
function judge(pair, mode, { vars, fills }) {
  const bgList = Array.isArray(pair.bg) ? pair.bg : [pair.bg]
  let fgVars = vars
  const top = bgList[bgList.length - 1]
  if (fills.classes.has(`bg-${top}`) || (pair.fill && fills.classes.has(pair.fill))) {
    fgVars = new Map(vars)
    for (const [k, v] of fills.decls) fgVars.set(k, v)
  }
  let ground = tokenColour(bgList[0], vars)
  if (ground.a < 1) throw new Error(`${pair.id}: the bottom of the ground is not opaque (${bgList[0]})`)
  for (const layer of bgList.slice(1)) ground = over(tokenColour(layer, vars), ground)
  const fg = over(tokenColour(pair.fg, fgVars), ground)
  const r = ratio(fg, ground)
  const need = NEED[pair.kind]
  if (need === undefined) throw new Error(`${pair.id}: unknown kind ${pair.kind}`)
  const ok = need === null ? null : r >= need
  return {
    id: pair.id, mode, kind: pair.kind, fg: pair.fg, bg: bgList.join(' + '), fgHex: toHex(fg), bgHex: toHex(ground),
    ratio: cut(r), need, ok, near: ok === true && r < need + NEAR, clipped: fg.clipped || ground.clipped, gate: pair.gate !== false,
  }
}

// ---- DESIGN.md: the components' pairs (default mode, YAML values) and the colour-mode table against index.css ----

function frontMatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  return m ? m[1] : ''
}

function yamlSection(text, key) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `${key}:`)
  if (start < 0) return []
  const out = []
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break
    out.push(l)
  }
  return out
}

export function designPairs(md) {
  const fm = frontMatter(md)
  const colours = new Map()
  for (const l of yamlSection(fm, 'colors')) {
    const m = l.match(/^ {2}([\w-]+):\s*"(#[0-9a-fA-F]{3,8})"/)
    if (m) colours.set(m[1], m[2])
  }
  const comps = new Map()
  let cur = null
  for (const l of yamlSection(fm, 'components')) {
    const head = l.match(/^ {2}([\w-]+):\s*$/)
    if (head) { cur = head[1]; comps.set(cur, {}); continue }
    const prop = l.match(/^ {4}(\w+):\s*"\{colors\.([\w-]+)\}"/)
    if (cur && prop) comps.get(cur)[prop[1]] = prop[2]
  }
  const pairs = []
  for (const [name, c] of comps) {
    if (!c.backgroundColor) continue
    const bg = colours.get(c.backgroundColor)
    if (!bg) continue
    if (c.textColor && colours.get(c.textColor)) pairs.push({ id: `DESIGN.md ${name} text`, fg: colours.get(c.textColor), bg: [bg], kind: 'text' })
    for (const edge of ['borderColor', 'markerColor']) {
      if (c[edge] && colours.get(c[edge])) pairs.push({ id: `DESIGN.md ${name} ${edge}`, fg: colours.get(c[edge]), bg: [bg], kind: 'nontext' })
    }
  }
  return pairs
}

// rows like "| `slate-900` | page | #0d1119 | #141414 | #f5f7f8 |" and "| `slate-100`·`ink` | text | #eef2f7 · #ffffff | …"
export function designTable(md) {
  const rows = []
  for (const line of md.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 7 || !cells[1].startsWith('`')) continue
    const tokens = [...cells[1].matchAll(/`([\w-]+)`/g)].map((m) => m[1])
    const perMode = cells.slice(3, 6).map((c) => c.split('·').map((x) => x.trim()))
    if (!perMode.every((vals) => vals.length === tokens.length && vals.every((x) => /^#[0-9a-fA-F]{6}$/.test(x)))) continue
    tokens.forEach((t, i) => MODES.forEach((mode, j) => rows.push({ token: t, mode, doc: perMode[j][i].toLowerCase() })))
  }
  return rows
}

// ---- class strings: one text colour and one bg colour in the same string ----

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const CLASS = (prefix) => new RegExp(`(?<![\\w:/-])${prefix}-([a-z]+(?:-[a-z]+)*(?:-\\d{2,3})?(?:/\\d{1,3})?)(?![\\w-])`, 'g')

export function usedPairs(srcDir, vars) {
  const found = new Map()
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const s = m[2]
      const known = (c) => vars.has(`--color-${c.split('/')[0]}`)
      const fg = [...s.matchAll(CLASS('text'))].map((x) => x[1]).filter(known)
      const bg = [...s.matchAll(CLASS('bg'))].map((x) => x[1]).filter(known)
      if (fg.length !== 1 || bg.length !== 1) continue
      const key = `${fg[0]} on ${bg[0]}`
      const line = text.slice(0, m.index).split('\n').length
      if (!found.has(key)) found.set(key, { fg: fg[0], bg: bg[0], at: [] })
      found.get(key).at.push(`${relative(join(srcDir, '..', '..'), file)}:${line}`)
    }
  }
  return [...found.values()]
}

// ---- run ----

const TEXT_STEPS = ['ink', 'slate-50', 'slate-100', 'slate-200', 'slate-300', 'slate-400', 'slate-500', 'primary-300', 'primary-400', 'red-300', 'red-400', 'amber-300', 'emerald-300', 'yellow-400', 'green-400']
const SURFACES = ['slate-950', 'slate-900', 'slate-800', 'slate-700']

function table(rows, columns) {
  const lines = [`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`]
  for (const r of rows) lines.push(`| ${columns.map((c) => String(r[c] ?? '')).join(' | ')} |`)
  return lines.join('\n')
}

const mark = (r) => (r.ok === null ? 'decorative' : r.ok ? (r.near ? 'near' : 'ok') : 'UNDER')

function main() {
  const o = args(process.argv.slice(2))
  const themeCss = readFileSync(o.theme, 'utf8')
  const indexCss = readFileSync(join(o.frontend, 'src', 'index.css'), 'utf8')
  const pairsFile = JSON.parse(readFileSync(o.pairs, 'utf8'))
  const md = existsSync(o.design) ? readFileSync(o.design, 'utf8') : ''
  const twPkg = join(dirname(o.theme), 'package.json')
  const twVersion = existsSync(twPkg) ? JSON.parse(readFileSync(twPkg, 'utf8')).version : '?'
  const result = { tailwind: twVersion, pairs: [], design: [], drift: [], used: [], matrix: [], errors: [] }
  const byMode = new Map(o.modes.map((m) => [m, modeVars(themeCss, indexCss, m)]))

  for (const [mode, mv] of byMode) {
    for (const p of pairsFile.pairs) {
      if (p.modes && !p.modes.includes(mode)) continue
      try { result.pairs.push(judge(p, mode, mv)) } catch (e) { result.errors.push(`${mode} ${p.id}: ${e.message}`) }
    }
  }
  if (md) {
    const empty = { vars: new Map(), fills: { classes: new Set(), decls: [] } }
    for (const p of designPairs(md)) result.design.push(judge(p, 'default (DESIGN.md YAML)', empty))
    for (const row of designTable(md)) {
      const mv = byMode.get(row.mode) ?? modeVars(themeCss, indexCss, row.mode)
      try {
        const code = toHex(tokenColour(row.token, mv.vars))
        const raw = mv.vars.get(`--color-${row.token}`) ?? ''
        if (code !== row.doc) result.drift.push({ token: row.token, mode: row.mode, doc: row.doc, code, exact: /^#/.test(raw.trim()) })
      } catch (e) { result.errors.push(`DESIGN.md table ${row.mode} ${row.token}: ${e.message}`) }
    }
  }
  if (o.used) {
    const mv = byMode.get('default') ?? modeVars(themeCss, indexCss, 'default')
    const used = usedPairs(join(o.frontend, 'src'), mv.vars)
    for (const [mode, m] of byMode) {
      for (const u of used) {
        // a see-through ground sits on a card, or on the page: both are read and the lower ratio kept
        const grounds = u.bg.includes('/') ? [['slate-800', u.bg], ['slate-900', u.bg]] : [[u.bg]]
        try {
          const rows = grounds.map((bg) => judge({ id: `${u.fg} on ${u.bg}`, fg: u.fg, bg, kind: 'text', fill: `bg-${u.bg}` }, mode, m))
          const worst = rows.sort((a, b) => a.ratio - b.ratio)[0]
          result.used.push({ ...worst, gate: false, uses: u.at.length, first: u.at[0] })
        } catch (e) { result.errors.push(`${mode} used ${u.fg} on ${u.bg}: ${e.message}`) }
      }
    }
  }
  if (o.matrix) {
    for (const mode of [...o.modes, 'brand']) {
      const m = byMode.get(mode) ?? modeVars(themeCss, indexCss, mode)
      for (const fg of TEXT_STEPS) for (const bg of SURFACES) {
        try { result.matrix.push({ ...judge({ id: `${fg} on ${bg}`, fg, bg: [bg], kind: 'text' }, mode, m), gate: false }) } catch (e) { result.errors.push(`${mode} matrix ${fg} on ${bg}: ${e.message}`) }
      }
    }
  }

  const cols = ['mode', 'id', 'kind', 'fgHex', 'bgHex', 'ratio', 'need', 'state', 'clipped', 'gate']
  const show = (rows) => rows.map((r) => ({ ...r, state: mark(r), clipped: r.clipped ? 'clipped' : '', gate: r.gate ? 'gate' : 'read only' }))
  const under = (rows) => rows.filter((r) => r.ok === false)
  console.log(`# token pair contrast — tailwind ${twVersion}, modes ${o.modes.join(', ')}\n`)
  console.log(`pairs ${result.pairs.length} · under ${under(result.pairs).length} · near ${result.pairs.filter((r) => r.near).length}`)
  console.log(`DESIGN.md components ${result.design.length} · under ${under(result.design).length} · table rows that disagree ${result.drift.length} (exact hex ${result.drift.filter((d) => d.exact).length})`)
  if (o.used) console.log(`used class pairs ${result.used.length} · under ${under(result.used).length} (read only)`)
  if (o.matrix) console.log(`matrix ${result.matrix.length} · under ${under(result.matrix).length} (read only)`)
  console.log(`errors ${result.errors.length}\n`)
  const flagged = [...result.pairs, ...result.design].filter((r) => r.ok === false || r.near)
  if (flagged.length) console.log(`## under or near\n\n${table(show(flagged), cols)}\n`)
  if (result.drift.length) console.log(`## DESIGN.md table vs index.css\n\n${table(result.drift, ['mode', 'token', 'doc', 'code', 'exact'])}\n`)
  if (o.used && under(result.used).length) console.log(`## used class pairs under the line (read only)\n\n${table(show(under(result.used)).map((r) => ({ ...r, id: `${r.id} (${r.uses}x, ${r.first})` })), cols)}\n`)
  if (o.matrix && under(result.matrix).length) console.log(`## matrix under the line (read only)\n\n${table(show(under(result.matrix)), cols)}\n`)
  if (result.errors.length) console.log(`## errors\n\n${result.errors.map((e) => `- ${e}`).join('\n')}\n`)
  if (o.json) writeFileSync(o.json, JSON.stringify(result, null, 1))

  const failed = under([...result.pairs, ...result.design].filter((r) => r.gate)).length + result.drift.filter((d) => d.exact).length + result.errors.length
  if (o.strict && failed > 0) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
