import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

// The screens the floating chat's checks open (floating-context.spec.ts, ai-layers-every-screen.spec.ts), read from the
// app's own sidebar config: every `href` in `navGroups` of frontend/src/components/Layout.tsx, the entries a feature or
// a permission shows included. A screen added to the sidebar is checked from then on, unless ai-layer-exempt.json names
// it with a reason and a PR.

const LAYOUT = join(__dirname, '../../frontend/src/components/Layout.tsx')

// The source between the `[` that opens navGroups' useMemo and the `]` that closes it, strings and comments skipped.
function navGroupsSource(src: string): string {
  const at = src.indexOf('const navGroups')
  const open = at < 0 ? -1 : src.indexOf('[', src.indexOf('useMemo(', at))
  if (open < 0) throw new Error(`${LAYOUT} has no "const navGroups … = useMemo(() => [": the floating chat checks read the sidebar there`)
  let depth = 0
  let quote = ''
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i)
    else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i) + 1
    else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error(`${LAYOUT}: navGroups' list does not close`)
}

// Every sidebar entry's address, in the sidebar's order ("/storage?tab=pvcs" keeps its tab).
export function sidebarHrefs(): string[] {
  const hrefs = [...new Set([...navGroupsSource(readFileSync(LAYOUT, 'utf8')).matchAll(/\bhref:\s*'([^']+)'/g)].map((m) => m[1]))]
  if (hrefs.length < 60) throw new Error(`${LAYOUT}: navGroups lists ${hrefs.length} addresses, not the sidebar's 70-odd: the parse no longer finds them`)
  return hrefs
}

export type AILayerExemption = { path: string; reason: string; pr: string }

function readExemptions(): AILayerExemption[] {
  const raw = JSON.parse(readFileSync(join(__dirname, 'ai-layer-exempt.json'), 'utf8')) as { screens: AILayerExemption[] }
  const listed = new Set(sidebarHrefs())
  for (const e of raw.screens) {
    if (!e.path?.startsWith('/') || !e.reason?.trim() || !e.pr?.trim()) {
      throw new Error(`an ai-layer exemption names a path, a reason and a PR: ${JSON.stringify(e)}`)
    }
    if (!listed.has(e.path)) throw new Error(`ai-layer-exempt.json names ${e.path}, which the sidebar no longer lists: take it out`)
  }
  return raw.screens
}

// The screens that send nothing to the floating chat by rule.
export const AI_LAYER_EXEMPT = readExemptions()

// The sidebar's screens the floating chat must be sent data for.
export const aiLayerScreens = (): string[] => sidebarHrefs().filter((href) => !AI_LAYER_EXEMPT.some((e) => e.path === href))

// The second cluster of the dev install (`default`) has Kyverno, metrics-server and OpenCost; `self` has the rest.
const ON_DEFAULT = new Set(['/security/policyreports', '/monitoring', '/cost'])
export const clusterFor = (href: string): string => (ON_DEFAULT.has(href.split('?')[0]) ? 'default' : 'self')

export const visitUrl = (href: string, cluster: string): string => `${href}${href.includes('?') ? '&' : '?'}cluster=${cluster}`

// What a screen needs done after it opens before it shows anything to tell: Advanced Search shows results, and sends its
// layer, once something is searched — `true`, which every object read matches, so its gaps ("N failed", "the first N
// only") and its 0 of an empty read are held as its results are (as number-check-search.spec.ts types it).
export const SEARCH_QUERY = 'true'
export async function prepareScreen(page: Page, href: string): Promise<void> {
  if (href.split('?')[0] !== '/cluster/search') return
  await page.locator('main .monaco-editor').first().click({ timeout: 20_000 })
  await page.keyboard.type(SEARCH_QUERY)
}
