import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

import { VIEWS, WRITE, general, judge, openView, readBaseline, report, viewContext, writeBaseline, type Findings, type View } from './a11y-views'
import { DRAWER } from './shared'

// The design keeps the screens' bones: the same landmarks, headings, controls, tabs and column headers with the same
// names in the same order. Each main screen's accessibility tree (locator.ariaSnapshot()) is cut down to those bones
// and compared line by line with the baseline written at the v0.7.9 tag (aria-tree-baseline.json). A line added,
// removed or moved fails unless a11y-views-intended.json names it (spec "aria-tree", the line as "+ …" or "- …").
// Cut away before comparing: plain text, a table's data rows (a row with cells; the header row stays), the query of
// a link's address, runs of the same line one after another (a list of like items), and in names digits, pod suffixes
// and "5 minutes ago" (general()). With E2E_BEFORE_URL (scripts/before-stack.sh up v0.7.9) the baseline is the old
// build itself, opened at the same moment, so the rows a cluster changes between two days cannot differ.

const BASELINE_FILE = path.join(__dirname, 'aria-tree-baseline.json')
const BEFORE = (process.env.E2E_BEFORE_URL || '').replace(/\/$/, '')
// what the bones keep: landmarks, headings, controls and the parts of tables, lists of tabs and menus
const KEEP = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'search', 'form', 'dialog', 'alertdialog',
  'heading', 'button', 'link', 'tab', 'tablist', 'tabpanel', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'radiogroup', 'switch', 'slider', 'spinbutton', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'table', 'grid', 'treegrid', 'columnheader', 'rowheader', 'tree', 'treeitem', 'progressbar', 'meter',
  'toolbar', 'img',
])
const STATES = new Set(['level', 'checked', 'expanded', 'selected', 'pressed', 'disabled'])

test.use({ trace: 'off', screenshot: 'off' })

type Node = { role: string; name: string; states: string; url: string; children: Node[] }

// ariaSnapshot()'s YAML: "- role "name" [state]: text", children indented two spaces, "- /url: …" a link's address.
const LINE = /^(\s*)- (\/?[a-z]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/

function parse(yaml: string): Node[] {
  const root: Node = { role: '', name: '', states: '', url: '', children: [] }
  const stack: { depth: number; node: Node }[] = [{ depth: -1, node: root }]
  for (const raw of yaml.split('\n')) {
    const m = LINE.exec(raw)
    if (!m) continue
    const depth = m[1].length / 2
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    const parent = stack[stack.length - 1].node
    if (m[2] === '/url') {
      parent.url = (m[5] ?? '').replace(/^"|"$/g, '').split('?')[0]
      continue
    }
    if (m[2].startsWith('/')) continue
    const states = [...(m[4] ?? '').matchAll(/\[([a-z]+)(?:=([^\]]*))?\]/g)].filter((s) => STATES.has(s[1])).map((s) => `[${s[1]}${s[2] ? `=${s[2]}` : ''}]`).join(' ')
    const node: Node = { role: m[2], name: m[3] ? (JSON.parse(m[3]) as string) : '', states, url: '', children: [] }
    parent.children.push(node)
    stack.push({ depth, node })
  }
  return root.children
}

const isDataRow = (n: Node) => n.role === 'row' && n.children.some((c) => c.role === 'cell' || c.role === 'gridcell')

// The bones, one line per kept node, indented by kept depth. A node not kept passes its children up.
function bones(nodes: Node[], depth = 0): string[] {
  const runs: string[][] = []
  for (const n of nodes) {
    if (isDataRow(n) || n.role === 'text') continue
    const lines = KEEP.has(n.role)
      ? [`${'  '.repeat(depth)}${[n.role, n.name ? `"${general(n.name)}"` : '', n.states, n.url ? `-> ${n.url}` : ''].filter(Boolean).join(' ')}`, ...bones(n.children, depth + 1)]
      : bones(n.children, depth)
    if (lines.length === 0) continue
    // a run of like items (the same lines one after another) is one item
    if (runs.length && runs[runs.length - 1].join('\n') === lines.join('\n')) continue
    runs.push(lines)
  }
  return runs.flat()
}

// The lines of `before` and `after` that differ, in order ("- " gone, "+ " new), from their longest common sequence.
function diff(before: string[], after: string[]): string[] {
  const n = before.length
  const m = after.length
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++
      j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${after[j++].trim()}`)
    else out.push(`- ${before[i++].trim()}`)
  }
  return out
}

async function treeOf(page: Page, view: View): Promise<string[]> {
  const root = view.drawer ? page.locator(DRAWER).last() : page.locator('body')
  return bones(parse(await root.ariaSnapshot({ timeout: 20_000 })))
}

test.describe('accessibility tree of the main screens', () => {
  test('keeps the landmarks, headings, controls and column headers of the baseline', async ({ browser }) => {
    const baseline = WRITE || BEFORE ? null : readBaseline(BASELINE_FILE)
    test.skip(!WRITE && !BEFORE && !baseline, 'no aria-tree-baseline.json: write it on the v0.7.9 install with E2E_A11Y_VIEWS_WRITE=1, or give E2E_BEFORE_URL')
    test.setTimeout(900_000)
    const context = await viewContext(browser)
    const found: Findings = {}
    const before: Findings = {}
    const failed: string[] = []
    try {
      for (const view of VIEWS) {
        const page = await context.newPage()
        try {
          await openView(page, view)
          found[view.id] = await treeOf(page, view)
          if (BEFORE) {
            const old = await context.newPage()
            try {
              await openView(old, view, BEFORE)
              before[view.id] = await treeOf(old, view)
              // the old build against itself once more when they differ: a tree that moves by itself is not the design's
              if (diff(before[view.id], found[view.id]).length > 0) {
                await openView(old, view, BEFORE)
                const again = await treeOf(old, view)
                if (diff(before[view.id], again).length > 0) failed.push(`${view.id}: the old build's tree moved by itself`)
              }
            } finally {
              await old.close()
            }
          }
        } catch (e) {
          failed.push(`${view.id}: ${String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 160)}`)
        } finally {
          await page.close()
        }
      }
    } finally {
      await context.close()
    }
    if (WRITE) {
      writeBaseline(BASELINE_FILE, found)
      await report('aria-tree', null, found, failed)
      expect(failed, 'screens that did not open').toEqual([])
      expect(Object.keys(found)).toEqual(VIEWS.map((v) => v.id))
      return
    }
    const reference = BEFORE ? before : baseline!.views
    const changes: Findings = Object.fromEntries(VIEWS.filter((v) => found[v.id] && reference[v.id]).map((v) => [v.id, diff(reference[v.id], found[v.id])]))
    const judged = judge('aria-tree', changes, {})
    await report('aria-tree', judged, changes, failed)
    expect(failed, 'screens that did not open').toEqual([])
    // the bones were read: a screen has its 77 sidebar links and its own controls, a drawer its header, tabs and sections
    expect(VIEWS.filter((v) => (found[v.id] ?? []).length < (v.drawer ? 8 : 40)).map((v) => v.id), 'screens with almost no tree').toEqual([])
    expect(VIEWS.filter((v) => !reference[v.id]).map((v) => v.id), 'screens the baseline does not hold').toEqual([])
    expect(judged.added, 'a change a PR means goes in a11y-views-intended.json with why and the PR').toEqual([])
    expect(judged.unusedRules, 'rules that passed nothing').toEqual([])
  })
})
