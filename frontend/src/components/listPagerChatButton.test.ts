import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { ListPager } from './ListPager'
import { ToggleButton } from './FloatingAIChat/ToggleButton'
import layoutSrc from './Layout.tsx?raw'
import pageSizeSrc from './PageSizeSelect.tsx?raw'
import clusterViewSrc from '@/pages/cluster-view/PodNodeGrid.tsx?raw'
import gpuPodsCardSrc from '@/pages/gpu/gpupods/GPUPodsCharts.tsx?raw'

// The floating AI chat button is fixed at the bottom-right of the screen. A list page sized to the screen, or any list
// scrolled to its end, ends its footer there, and the button sat on the right of the footer's Next — at 1440×900 as
// at 1280 or 1920 wide, since both sit a fixed distance from the screen's right and bottom edges. On a page with the
// floating chat the footer's page buttons stop short of the button, worked out here from the classes that place them.
// Only a footer that ends a page across its width gets that room: a section's or a card's (the GPU screens) ends
// elsewhere, and the button would only push its buttons in from its edge.

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')
const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const render = (el: ReactElement) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, el))
// a list page's footer unless told otherwise
const pager = (props: { showPageSize?: boolean; endsPage?: boolean } = {}) =>
  render(createElement(ListPager, { currentPage: 2, totalPages: 3, total: 60, rowsPerPage: 20, onPageChange: () => {}, ...props }))
const toggle = (docked = false) => render(createElement(ToggleButton, { onClick: () => {}, visible: true, docked }))

// px of a Tailwind spacing class among `classes` (4 px a step), e.g. right-6 → 24
function step(classes: string, name: string): number {
  const m = new RegExp(`(?:^|\\s)${name}-(\\d+)(?:\\s|$)`).exec(classes)
  if (!m) throw new Error(`no ${name}-N in "${classes}"`)
  return Number(m[1]) * 4
}

describe('the floating chat button and a list footer on a page', () => {
  it('the page buttons are one group, Next its last button', () => {
    const group = /<div class="list-pager-pages[^"]*">(.*?)<\/div>/.exec(pager())?.[1] ?? ''
    expect(group.match(/<button/g)?.length, 'Previous and Next in the group').toBe(2)
    expect(group.endsWith(`>${en.common.next}</button>`), 'Next ends the group').toBe(true)
  })

  it('Layout marks its main as having the floating chat only when it draws the chat', () => {
    expect(layoutSrc).toContain('{aiOn && <FloatingAIChat />}')
    expect(layoutSrc).toMatch(/<main className=\{`[^`]*\$\{aiOn \? ' floating-chat-room' : ''\}`\}>/)
  })

  it('the room is for footers inside that main only: windows and the drawer keep their buttons at the edge', () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*\.list-pager-pages[^{}]*)\{/g)].map((m) => m[1].trim())
    expect(selectors).toEqual(['.floating-chat-room .list-pager-pages'])
  })

  it('Next ends at least 8 px short of the button on a page whose list spans it', () => {
    const button = /data-testid="floating-chat-toggle" class="([^"]*)"/.exec(toggle())?.[1] ?? ''
    // the button's left edge, from the screen's right edge: its offset and its width (right-6 w-12 = 72 px)
    const reach = step(button, 'right') + step(button, 'w')
    // Next's right edge, from the screen's right edge: main's padding, the footer's own and the room (the list card's
    // 1 px border left out, so the gap is at least this)
    const main = Number(/\? '' : 'p-(\d+)'/.exec(layoutSrc)?.[1]) * 4
    const footer = step(/<div class="([^"]*)" data-testid="list-pager"/.exec(pager())?.[1] ?? '', 'px')
    const room = /\.floating-chat-room \.list-pager-pages\s*\{\s*margin-right:\s*([\d.]+)rem;/.exec(css)
    expect(main, "main's padding").toBeGreaterThan(0)
    expect(room, 'a margin in rem').not.toBeNull()
    const edge = main + footer + Number(room![1]) * 16
    expect(edge - reach, `Next's right edge ${edge} px in, the button ${reach} px in`).toBeGreaterThanOrEqual(8)
  })

  it('the room is for a footer that ends a page: a list page\'s and Cluster View\'s two, not a section\'s', () => {
    const roomy = (html: string) => /<div class="list-pager-pages /.test(html)
    expect({
      listPage: roomy(pager()),
      section: roomy(pager({ showPageSize: false })),
      endsPage: roomy(pager({ showPageSize: false, endsPage: true })),
    }).toEqual({ listPage: true, section: false, endsPage: true })
    // the node boxes under the map and a node's own pods end the Cluster View page; the GPU Pods node card is a column
    expect(clusterViewSrc.match(/showPageSize=\{false\}\s+endsPage\s+testId="cluster-view-node(s|-pods)-pager"/g)).toHaveLength(2)
    expect(gpuPodsCardSrc).not.toContain('endsPage')
  })

  // The detail drawer open (min-[1348px]): the button sits left of the drawer, over the footer's left part — the
  // rows-per-page choice and the range — not its page buttons; at the narrowest such screen it stays clear of the choice.
  it('with the detail drawer open, the button stays clear of the rows-per-page choice', () => {
    const button = /data-testid="floating-chat-toggle" class="([^"]*)"/.exec(toggle(true))?.[1] ?? ''
    const docked = /min-\[(\d+)px\]:right-\[(\d+)px\]/.exec(button)
    expect(docked, 'the button moves at a screen width').not.toBeNull()
    const [screen, offset] = [Number(docked![1]), Number(docked![2])]
    const buttonLeft = screen - offset - step(button, 'w')
    // the choice's right edge from the screen's left: the sidebar, main's padding, the footer's, the label (12 px type:
    // a Hangul letter 1 em, any other at most 0.7 em; the wider of en and ko), the gap and the dropdown
    const sidebar = Number(/<div className="pl-(\d+)">/.exec(layoutSrc)?.[1]) * 4
    const main = Number(/\? '' : 'p-(\d+)'/.exec(layoutSrc)?.[1]) * 4
    const footer = step(/<div class="([^"]*)" data-testid="list-pager"/.exec(pager())?.[1] ?? '', 'px')
    const label = Math.max(...[en.common.pageSize.label, ko.common.pageSize.label].map((s) => [...s].reduce((w, c) => w + (/[가-힣]/.test(c) ? 12 : 12 * 0.7), 0)))
    const gap = step(/<div className="([^"]*)" data-testid="page-size">/.exec(pageSizeSrc)?.[1] ?? '', 'gap')
    const dropdown = step(/className="(w-\d+)"/.exec(pageSizeSrc)?.[1] ?? '', 'w')
    const choiceRight = sidebar + main + footer + label + gap + dropdown
    expect(sidebar * main, 'the sidebar and main\'s padding read').toBeGreaterThan(0)
    expect(buttonLeft - choiceRight, `at ${screen} px the button starts ${buttonLeft} px in, the choice ends ${choiceRight} px in`).toBeGreaterThanOrEqual(8)
  })
})
