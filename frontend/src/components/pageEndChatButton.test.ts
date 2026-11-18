import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToggleButton } from './FloatingAIChat/ToggleButton'
import layoutSrc from './Layout.tsx?raw'
import searchTableSrc from './search/SearchResultTable.tsx?raw'
import aiUsageSrc from '@/pages/AdminAIUsage.tsx?raw'
import aiModelsSrc from '@/pages/AdminAIModels.tsx?raw'
import searchPageSrc from '@/pages/AdvancedSearch.tsx?raw'

// The floating AI chat button is fixed at the bottom-right of the screen. Besides a list page's footer (#949,
// listPagerChatButton.test.ts), three things ended a page under it on the 11-18 hand check and the sweep after it:
// the end of AI Usage's note under its list, Advanced Search's next-page button, and the Update button of the last
// AI model's edit form at the end of that page. Each keeps clear of the button, worked out here from the classes
// that place them.

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const button = /data-testid="floating-chat-toggle" class="([^"]*)"/.exec(
  renderToStaticMarkup(createElement(ToggleButton, { onClick: () => {}, visible: true, docked: false })),
)?.[1] ?? ''

// px of a Tailwind spacing class among `classes` (4 px a step), e.g. right-6 → 24
function step(classes: string, name: string): number {
  const m = new RegExp(`(?:^|\\s)${name}-(\\d+)(?:\\s|$)`).exec(classes)
  if (!m) throw new Error(`no ${name}-N in "${classes}"`)
  return Number(m[1]) * 4
}
// px of a rule's margin-right or padding-bottom in rem
function rem(selector: string, property: string): number {
  const m = new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{\\s*${property}:\\s*([\\d.]+)rem;`).exec(css)
  if (!m) throw new Error(`no ${property} in rem for ${selector}`)
  return Number(m[1]) * 16
}

// the button's left edge and top, from the screen's right and bottom edges (right-6 w-12, bottom-6 h-12 = 72 px)
const reach = step(button, 'right') + step(button, 'w')
const rise = step(button, 'bottom') + step(button, 'h')
// main's padding
const main = Number(/\? '' : 'p-(\d+)'/.exec(layoutSrc)?.[1]) * 4

describe('the floating chat button and what ends a page', () => {
  it('AI Usage: the note under the list ends where the footer\'s page buttons end, at least 8 px short of the button', () => {
    expect(aiUsageSrc).toMatch(/<p className="list-page-note [^"]*" data-testid="ai-usage-note">/)
    // the note is the page's last line, under the list's card
    expect(aiUsageSrc.indexOf('data-testid="ai-usage-note"')).toBeGreaterThan(aiUsageSrc.indexOf('testId="ai-usage-pager"'))
    const note = main + rem('.floating-chat-room .list-page-note', 'margin-right')
    // Next of a list footer: main's padding, the footer's px-4 and its room
    const next = main + 16 + rem('.floating-chat-room .list-pager-pages', 'margin-right')
    expect(main, "main's padding").toBeGreaterThan(0)
    expect(note, 'the note ends where Next ends').toBe(next)
    expect(note - reach, `the note's right edge ${note} px in, the button ${reach} px in`).toBeGreaterThanOrEqual(8)
  })

  it('Advanced Search: its page buttons take the list footer\'s room and end at least 8 px short of the button', () => {
    expect(searchTableSrc).toMatch(/data-testid="search-pager">[\s\S]*?<div className="list-pager-pages flex items-center gap-1">/)
    // the page's own padding and the footer row's px-1 put it further in on a screen narrower than its max-w
    const page = step(/<div className="([^"]*h-\[calc\(100vh-4rem\)\][^"]*)">/.exec(searchPageSrc)?.[1] ?? '', 'p')
    const row = step(/<div className="([^"]*)" data-testid="search-pager">/.exec(searchTableSrc)?.[1] ?? '', 'px')
    const next = main + page + row + rem('.floating-chat-room .list-pager-pages', 'margin-right')
    expect(next - reach, `Next's right edge ${next} px in, the button ${reach} px in`).toBeGreaterThanOrEqual(8)
  })

  it('AI Models: the page is marked as longer than the screen, so its last row ends at least 8 px above the button', () => {
    expect(aiModelsSrc).toMatch(/<div className="page-scrolls [^"]*">\s*\{\/\* header \*\/\}/)
    const end = main + rem('.page-scrolls', 'padding-bottom')
    expect(end - rise, `the page's last row ${end} px up, the button's top ${rise} px up`).toBeGreaterThanOrEqual(8)
  })
})
