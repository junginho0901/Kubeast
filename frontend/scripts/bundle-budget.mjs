#!/usr/bin/env node
// The bundle's size against its budget, from a finished `vite build` (frontend/dist). gzip as a browser would fetch it
// (node:zlib, level 9): the entry script and stylesheet, what index.html makes the browser fetch before the first
// screen (entry, modulepreload, stylesheets), every script and stylesheet together, the font, and the chunks over Vite's
// warning line (500 kB before compression, build.chunkSizeWarningLimit).
//
//   npm run check:bundle -- [--dist <frontend/dist>] [--budget <bundle-budget.json>] [--write-baseline <ref>] [--strict]
//
// A measure over its baseline by more than the margin (budget "margin", 0.10 = 10%) is listed, and so is a chunk over
// 500 kB that the baseline did not have; --strict exits 1 on either. Any growth over "notice" is printed. Chunks are
// named without their content hash (index-8IAeznVU.js is "index.js"). --write-baseline <ref> stores this build's
// measures as the baseline, ref being the commit or tag it was built from.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const WARN_LINE = 500 * 1000

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist') out.dist = argv[++i]
    else if (a === '--budget') out.budget = argv[++i]
    else if (a === '--write-baseline') out.write = argv[++i]
    else if (a === '--strict') out.strict = true
    else throw new Error(`unknown argument ${a}`)
  }
  out.dist ??= join(HERE, '..', 'dist')
  out.budget ??= join(HERE, 'bundle-budget.json')
  return out
}

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, out)
    else out.push(p)
  }
  return out
}

const chunkName = (file) => file.split('/').pop().replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, '$1')
const gz = (buf) => gzipSync(buf, { level: 9 }).length

export function measure(dist) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const asset = (re) => [...html.matchAll(re)].map((m) => m[1].replace(/^\//, ''))
  const entryJs = asset(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)
  const preload = asset(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)
  const css = asset(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)
  const sizes = new Map()
  for (const p of files(dist)) {
    const rel = p.slice(dist.length + 1)
    const buf = readFileSync(p)
    sizes.set(rel, { raw: buf.length, gzip: /\.(js|css|html|svg|json)$/.test(rel) ? gz(buf) : buf.length })
  }
  const sum = (list, key) => list.reduce((n, f) => n + (sizes.get(f)?.[key] ?? 0), 0)
  const all = [...sizes.keys()]
  const js = all.filter((f) => f.endsWith('.js'))
  const styles = all.filter((f) => f.endsWith('.css'))
  const fonts = all.filter((f) => /\.(woff2?|ttf|otf)$/.test(f) && f.startsWith('fonts/'))
  return {
    measures: {
      entryJsGzip: sum(entryJs, 'gzip'),
      entryCssGzip: sum(css, 'gzip'),
      firstScreenGzip: sum([...new Set([...entryJs, ...preload, ...css])], 'gzip'),
      allJsGzip: sum(js, 'gzip'),
      allCssGzip: sum(styles, 'gzip'),
      fontBytes: sum(fonts, 'raw'),
    },
    counts: { js: js.length, css: styles.length, preload: preload.length },
    overWarnLine: js.filter((f) => sizes.get(f).raw > WARN_LINE).map(chunkName).sort(),
  }
}

const kb = (n) => `${(n / 1000).toFixed(2)} kB`

function main() {
  const o = args(process.argv.slice(2))
  const now = measure(o.dist)
  const budget = existsSync(o.budget) ? JSON.parse(readFileSync(o.budget, 'utf8')) : { margin: 0.1, notice: 0.01 }
  if (o.write) {
    budget.baseline = { ref: o.write, at: new Date().toISOString(), ...now }
    writeFileSync(o.budget, JSON.stringify(budget, null, 2) + '\n')
    console.log(`baseline written for ${o.write}`)
  }
  const base = budget.baseline
  const over = []
  console.log('| measure | now | baseline | change | limit |\n|---|---|---|---|---|')
  for (const [k, v] of Object.entries(now.measures)) {
    const b = base?.measures?.[k]
    const change = b ? (v - b) / b : 0
    const limit = b ? b * (1 + (k === 'fontBytes' ? 0 : budget.margin)) : null
    if (limit !== null && v > limit) over.push(`${k}: ${kb(v)} over ${kb(limit)}`)
    const flag = b && change > budget.notice ? ' (grew)' : ''
    console.log(`| ${k} | ${kb(v)} | ${b ? kb(b) : '-'} | ${b ? `${(change * 100).toFixed(2)}%${flag}` : '-'} | ${limit !== null ? kb(limit) : '-'} |`)
  }
  const newBig = now.overWarnLine.filter((c) => !(base?.overWarnLine ?? []).includes(c))
  console.log(`\nchunks over 500 kB: ${now.overWarnLine.join(', ') || 'none'}${newBig.length ? ` — new: ${newBig.join(', ')}` : ''}`)
  console.log(`scripts ${now.counts.js} · stylesheets ${now.counts.css} · modulepreload ${now.counts.preload}`)
  if (!base) console.log('\nno baseline yet: --write-baseline <ref> on the release tag')
  if (over.length) console.log(`\nover the budget:\n${over.map((x) => `- ${x}`).join('\n')}`)
  if (o.strict && (over.length > 0 || newBig.length > 0)) process.exit(1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
