#!/usr/bin/env node
// Hand-written colours in the console's code: a colour a component writes itself instead of naming a token, which a
// token change or a colour mode then does not reach (DESIGN.md: "Do use slate-*, primary-* and ink classes; don't
// write a hex colour in a component"). Reads frontend/src — *.ts and *.tsx without their tests, with the TypeScript
// parser the build already has, so comments and names are not read as colours — and the *.css files.
//
//   npm run check:colours -- [--frontend <dir>] [--exempt <file>] [--strict] [--json <out>]     (in frontend)
//
// Kinds:
//   hex              #rgb … #rrggbbaa, and %23rrggbb inside a data URI
//   colour-function  rgb() rgba() hsl() hsla() hwb() lab() lch() oklab() oklch() with numbers in it
//   arbitrary-class  a Tailwind class with a colour in brackets: bg-[#020617], text-[rgb(…)], [color:…]
//   named-colour     white, red, tomato … as a style value or an SVG paint attribute
//   off-palette      a hue DESIGN.md keeps off the console as a class: orange, lime, teal, cyan, sky, blue, indigo,
//                    violet, purple, fuchsia, pink, rose, zinc, neutral, stone
// Not counted: a token's own definition (a custom property in index.css), a token read with a fallback
// (cssColor('--color-x', '#hex')), the browser console's %c styles, import paths, href and id values, tests.
// What the exempt file lets through is listed apart with its why; --strict exits 1 on anything else, and on an
// exempt rule that let nothing through (a stale rule hides the next one).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OFF_PALETTE = ['orange', 'lime', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'zinc', 'neutral', 'stone']
const STATE_HUES = ['red', 'amber', 'yellow', 'emerald', 'green']
const UTILITIES = 'bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|placeholder|accent|caret|shadow'
const NAMED = new Set(('white black red green blue yellow orange purple pink gray grey silver navy teal cyan magenta lime maroon olive ' +
  'aqua fuchsia gold indigo violet brown tomato coral salmon crimson khaki beige ivory azure lavender orchid plum tan wheat ' +
  'chocolate firebrick darkred darkgreen darkblue darkgray darkgrey lightgray lightgrey whitesmoke gainsboro skyblue steelblue ' +
  'slategray slategrey royalblue dodgerblue limegreen seagreen orangered goldenrod hotpink deeppink').split(' '))
const COLOUR_PROPS = new Set(['color', 'background', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor',
  'borderLeftColor', 'borderRightColor', 'outlineColor', 'fill', 'stroke', 'stopColor', 'floodColor', 'lightingColor',
  'caretColor', 'accentColor', 'textDecorationColor', 'columnRuleColor'])
const PAINT_ATTRS = new Set(['fill', 'stroke', 'color', 'stopColor', 'floodColor', 'lightingColor'])
const SKIP_ATTRS = new Set(['href', 'id', 'htmlFor', 'to', 'key', 'data-testid'])

const PATTERNS = {
  hex: /(?<![&\w])(?:#|%23)(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
  'colour-function': /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?:[-+.\d]|\$\{)/g,
  'arbitrary-class': /(?<![\w-])!?[a-z][\w-]*-\[(?:#|%23|rgba?\(|hsla?\(|oklch\(|oklab\(|color:)[^\]\s]*\]|\[color:[^\]\s]+\]/g,
  'off-palette': new RegExp(`(?<![\\w-])!?(?:[\\w-]+:)*(?:${UTILITIES})-(?:${OFF_PALETTE.join('|')})-\\d{2,3}(?:/\\d{1,3})?(?![\\w-])`, 'g'),
}
const STATE = new RegExp(`(?<![\\w-])!?(?:[\\w-]+:)*(?:${UTILITIES})-(${STATE_HUES.join('|')})-\\d{2,3}(?:/\\d{1,3})?(?![\\w-])`, 'g')

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--frontend') out.frontend = argv[++i]
    else if (a === '--exempt') out.exempt = argv[++i]
    else if (a === '--json') out.json = argv[++i]
    else if (a === '--strict') out.strict = true
    else throw new Error(`unknown argument ${a}`)
  }
  out.frontend ??= join(HERE, '..')
  out.exempt ??= join(HERE, 'hand-colours-exempt.json')
  return out
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out) }
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

function scan(text, kinds = Object.keys(PATTERNS)) {
  const out = []
  for (const kind of kinds) for (const m of text.matchAll(PATTERNS[kind])) out.push({ kind, text: m[0], at: m.index })
  return out
}

// ---- TypeScript: the strings a file writes, with where they stand ----

function tsFindings(ts, file, text, add, state) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const skip = (node) => {
    const p = node.parent
    if (!p) return ''
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return 'import'
    if (ts.isCallExpression(p) && p.arguments.includes(node)) {
      if (/^console\./.test(p.expression.getText(sf))) return 'console'
      const first = p.arguments[0]
      if (first !== node && first && ts.isStringLiteralLike(first) && first.text.startsWith('--color-')) return 'token fallback'
    }
    if (ts.isJsxAttribute(p) && SKIP_ATTRS.has(p.name.getText(sf))) return 'attribute'
    return ''
  }
  const strings = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, node }
    // a template: its parts with ${} where a value goes, so `rgb(${l}, …)` still reads as a colour function
    if (ts.isTemplateExpression(node)) return { text: [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('${}'), node }
    return null
  }
  const visit = (node) => {
    const s = strings(node)
    if (s) {
      const why = skip(node)
      if (!why) {
        for (const f of scan(s.text)) add({ ...f, line: lineOf(node.getStart(sf)) })
        for (const m of s.text.matchAll(STATE)) state.set(m[1], (state.get(m[1]) ?? 0) + 1)
      }
      if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) visit(span.expression)
      return
    }
    // { color: 'white' } and the like
    if (ts.isPropertyAssignment(node) && COLOUR_PROPS.has(node.name.getText(sf).replace(/['"]/g, '')) && ts.isStringLiteralLike(node.initializer)) {
      const v = node.initializer.text.trim().toLowerCase()
      if (NAMED.has(v)) add({ kind: 'named-colour', text: `${node.name.getText(sf)}: ${v}`, line: lineOf(node.getStart(sf)) })
    }
    // <rect fill="white"> — only on an element of the page, not on a component's own prop (SummaryBadge color="green")
    if (ts.isJsxAttribute(node) && PAINT_ATTRS.has(node.name.getText(sf)) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const tag = node.parent?.parent && (ts.isJsxOpeningElement(node.parent.parent) || ts.isJsxSelfClosingElement(node.parent.parent)) ? node.parent.parent.tagName.getText(sf) : ''
      const v = node.initializer.text.trim().toLowerCase()
      if (/^[a-z]/.test(tag) && NAMED.has(v)) add({ kind: 'named-colour', text: `<${tag} ${node.name.getText(sf)}="${v}">`, line: lineOf(node.getStart(sf)) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

// ---- CSS: declarations with their line, a custom property in index.css being a token's definition ----

function cssFindings(file, text, add, state) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const tokenFile = file.endsWith(join('src', 'index.css'))
  let buf = ''
  let start = 0
  let quote = ''
  let paren = 0
  const flush = () => {
    const decl = buf.trim()
    buf = ''
    if (!decl) return
    const line = css.slice(0, start).split('\n').length
    const colon = decl.indexOf(':')
    const name = colon > 0 ? decl.slice(0, colon).trim() : ''
    if (tokenFile && name.startsWith('--')) return
    if (name.startsWith('@apply') || decl.startsWith('@apply')) {
      for (const f of scan(decl, ['arbitrary-class', 'off-palette'])) add({ ...f, line })
      for (const m of decl.matchAll(STATE)) state.set(m[1], (state.get(m[1]) ?? 0) + 1)
      return
    }
    if (!name || decl.startsWith('@')) return
    const value = decl.slice(colon + 1)
    for (const f of scan(value, ['hex', 'colour-function'])) add({ ...f, line })
    if (/color|background|border|fill|stroke|outline|shadow/.test(name)) {
      // the words of the value itself: not a variable's name (--color-gray-200) nor what a url() holds
      const words = value.replace(/url\([^)]*\)/g, '').replace(/--[\w-]+/g, '').toLowerCase().match(/[a-z]+/g) ?? []
      for (const w of words) if (NAMED.has(w)) add({ kind: 'named-colour', text: `${name}: ${w}`, line })
    }
  }
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (!buf.trim() && !/\s/.test(ch)) start = i
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue }
    if (ch === '(') paren += 1
    if (ch === ')') paren -= 1
    if (paren > 0) { buf += ch; continue }
    if (ch === '{') { buf = ''; continue }
    if (ch === ';' || ch === '}') { flush(); continue }
    buf += ch
  }
}

// ---- exempt rules ----

function loadExempt(file) {
  if (!existsSync(file)) return []
  return JSON.parse(readFileSync(file, 'utf8')).rules.map((r, i) => {
    if (!r.file || !r.why?.trim()) throw new Error(`exempt rule ${i} needs a file and a why`)
    return { ...r, used: 0 }
  })
}

function exemptBy(rules, f) {
  return rules.find((r) => r.file === f.file && (!r.kinds || r.kinds.includes(f.kind)) && (!r.match || f.text.includes(r.match))) ?? null
}

function main() {
  const o = args(process.argv.slice(2))
  const src = join(o.frontend, 'src')
  const repo = join(o.frontend, '..')
  const ts = createRequire(join(o.frontend, 'package.json'))('typescript')
  const rules = loadExempt(o.exempt)
  const found = []
  const state = new Map()
  for (const file of walk(src)) {
    const rel = relative(repo, file)
    const text = readFileSync(file, 'utf8')
    const add = (f) => found.push({ file: rel, ...f })
    if (file.endsWith('.css')) cssFindings(file, text, add, state)
    else tsFindings(ts, file, text, add, state)
  }
  // one line, one kind, one text: a class string read twice (a template's parts) counts once
  const seen = new Set()
  const unique = found.filter((f) => {
    const k = `${f.file}:${f.line}:${f.kind}:${f.text}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const left = []
  const exempt = []
  for (const f of unique) {
    const r = exemptBy(rules, f)
    if (r) { r.used += 1; exempt.push({ ...f, why: r.why }) } else left.push(f)
  }
  const stale = rules.filter((r) => r.used === 0)

  const kinds = ['hex', 'colour-function', 'arbitrary-class', 'named-colour', 'off-palette']
  console.log(`# hand-written colours — typescript ${ts.version}\n`)
  console.log('| kind | found | exempt | left |\n|---|---|---|---|')
  for (const k of kinds) console.log(`| ${k} | ${unique.filter((f) => f.kind === k).length} | ${exempt.filter((f) => f.kind === k).length} | ${left.filter((f) => f.kind === k).length} |`)
  console.log(`\nstate hue classes (read only — a later move to role tokens): ${STATE_HUES.map((h) => `${h} ${state.get(h) ?? 0}`).join(' · ')}`)
  if (left.length) console.log(`\n## left\n\n${left.map((f) => `- ${f.file}:${f.line} ${f.kind} \`${f.text.slice(0, 60)}\``).join('\n')}`)
  if (stale.length) console.log(`\n## exempt rules that let nothing through\n\n${stale.map((r) => `- ${r.file} ${r.kinds?.join(',') ?? 'all'}${r.match ? ` "${r.match}"` : ''}`).join('\n')}`)
  if (o.json) writeFileSync(o.json, JSON.stringify({ typescript: ts.version, left, exempt, stale: stale.map(({ used, ...r }) => r), state: Object.fromEntries(state) }, null, 1))
  if (o.strict && (left.length > 0 || stale.length > 0)) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
