import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A drawer's table fits the drawer: its narrowest width is no wider than a section's box at the drawer's widest, so
// no column and no header ("Last Transition" of the Conditions table) sits past the box's edge behind a scroll that
// a trackpad's hidden scrollbar does not show. The box is the drawer less its border, its padding (p-5) and a
// section's border and padding (InfoSection's p-4), less a classic scrollbar (17 px, Chrome on Windows) for a drawer
// longer than the screen. A table inside a card of a section is narrower still: e2e drawer-tables-fit holds those.
const dir = fileURLToPath(new URL('.', import.meta.url))
const read = (file: string) => readFileSync(file, 'utf8')

const drawerWidth = () => {
  const src = read(join(dir, '../ResourceDetailDrawer.tsx'))
  const panel = src.match(/className="fixed inset-y-0 right-0 w-full max-w-\[(\d+)px\] [^"]*border-l\b[^"]*"/)
  const content = src.match(/<div className="p-(\d+) space-y-6 text-sm">/)
  expect(panel, 'the drawer panel: fixed, right, max-w-[Npx], border-l').not.toBeNull()
  expect(content, 'the Info tab content: p-N').not.toBeNull()
  return { max: Number(panel![1]), padding: Number(content![1]) * 4 }
}

const sectionPadding = () => {
  const src = read(join(dir, 'DetailCommon.tsx'))
  const section = src.match(/export function InfoSection[\s\S]*?<div className="rounded-lg border border-slate-700 bg-slate-900\/40 p-(\d+)">/)
  expect(section, 'InfoSection: a 1 px border and p-N').not.toBeNull()
  return Number(section![1]) * 4
}

const CLASSIC_SCROLLBAR = 17

function drawerSectionBox(): number {
  const { max, padding } = drawerWidth()
  return max - 1 - 2 * padding - 2 * (1 + sectionPadding()) - CLASSIC_SCROLLBAR
}

const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name))
    else if (/\.tsx$/.test(e.name)) files.push(join(d, e.name))
  }
}
walk(dir)

// every <table … min-w-[Npx] …> as file:line and its width
const tableMinWidths = () => files.flatMap((f) => read(f).split('\n').flatMap((line, i) => {
  const m = line.match(/<table\b[^>]*\bmin-w-\[(\d+)px\]/)
  return m ? [{ at: `${relative(dir, f)}:${i + 1}`, width: Number(m[1]) }] : []
}))

describe('drawer tables', () => {
  it('a section of the drawer at its widest is 648 px across', () => {
    expect(drawerSectionBox()).toBe(648)
  })

  it('are no wider at their narrowest than a section of the drawer', () => {
    const box = drawerSectionBox()
    const tables = tableMinWidths()
    expect(tables.length, 'the drawer tables were found').toBeGreaterThan(40)
    expect(tables.filter((t) => t.width > box).map((t) => `${t.at} min-w-[${t.width}px]`)).toEqual([])
  })
})
