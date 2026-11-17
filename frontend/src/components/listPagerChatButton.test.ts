import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import { ListPager } from './ListPager'
import { ToggleButton } from './FloatingAIChat/ToggleButton'
import layoutSrc from './Layout.tsx?raw'

// The floating AI chat button is fixed at the bottom-right of the screen. A list page sized to the screen, or any list
// scrolled to its end, ends its footer there, and the button sat on the right of the footer's Next — at 1440×900 as
// at 1280 or 1920 wide, since both sit a fixed distance from the screen's right and bottom edges. On a page with the
// floating chat the footer's page buttons stop short of the button, worked out here from the classes that place them.

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')
const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const render = (el: ReactElement) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, el))
const pager = () => render(createElement(ListPager, { currentPage: 2, totalPages: 3, total: 60, rowsPerPage: 20, onPageChange: () => {}, showPageSize: false }))
const toggle = () => render(createElement(ToggleButton, { onClick: () => {}, visible: true, docked: false }))

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
})
