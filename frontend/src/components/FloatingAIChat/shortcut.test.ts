import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { ToggleButton } from './ToggleButton'
import { focusOrigin, returnFocus } from './focusReturn'
import indexSrc from './index.tsx?raw'
import chatPanelSrc from './ChatPanel.tsx?raw'
import layoutSrc from '@/components/Layout.tsx?raw'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
afterEach(() => vi.unstubAllGlobals())

function button(platform: { platform?: string; userAgentData?: { platform: string } }, lng = 'en') {
  vi.stubGlobal('navigator', platform)
  void i18n.changeLanguage(lng)
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ToggleButton, { onClick: () => {}, visible: true, docked: false })))
  const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1]
  return { label: attr('aria-label'), title: attr('title'), keys: attr('aria-keyshortcuts') }
}

describe('the floating chat button names its shortcut', () => {
  it('⌘/ on a Mac, in English and Korean, with the name the specs find it by unchanged', () => {
    expect(button({ platform: 'MacIntel' })).toEqual({ label: 'Open AI Chat', title: 'Open AI Chat (⌘/)', keys: 'Meta+Slash' })
    expect(button({ userAgentData: { platform: 'macOS' } }, 'ko')).toEqual({ label: 'AI Chat 열기', title: 'AI Chat 열기 (⌘/)', keys: 'Meta+Slash' })
  })

  it('Ctrl+/ on Windows and Linux', () => {
    expect(button({ platform: 'Win32' })).toEqual({ label: 'Open AI Chat', title: 'Open AI Chat (Ctrl+/)', keys: 'Control+Slash' })
    expect(button({ userAgentData: { platform: 'Linux' } }, 'ko')).toEqual({ label: 'AI Chat 열기', title: 'AI Chat 열기 (Ctrl+/)', keys: 'Control+Slash' })
  })
})

// a page of fake elements: focus() moves the document's focus, as the browser's does for an element that can take it
function page() {
  const doc: { activeElement: object | null; body: object } = { activeElement: null, body: {} }
  doc.activeElement = doc.body
  const el = (canFocus = true) => {
    const e = { isConnected: true, focus: vi.fn(() => { if (canFocus) doc.activeElement = e }) }
    return e
  }
  const field = el(), toggle = el(), input = el(), elsewhere = el()
  const panel = { contains: (n: unknown) => n === input }
  return { doc: doc as unknown as Document, raw: doc, el, field, toggle, input, elsewhere, panel }
}

describe('the floating chat gives the focus back when it closes', () => {
  it('to the field that had it when the chat opened, from the input or from the page', () => {
    const p = page()
    p.raw.activeElement = p.field
    const from = focusOrigin(p.doc)
    expect(from).toBe(p.field)
    p.raw.activeElement = p.input
    expect(returnFocus(p.doc, p.panel, p.field, p.toggle)).toBe('back')
    expect(p.raw.activeElement).toBe(p.field)
    p.raw.activeElement = p.raw.body
    expect(returnFocus(p.doc, p.panel, p.field, p.toggle)).toBe('back')
  })

  it('to the button when it opened from the page itself or from the button, or what had it is gone or refuses it', () => {
    const p = page()
    expect(focusOrigin(p.doc), 'the page itself had it').toBeNull()
    p.raw.activeElement = p.input
    expect(returnFocus(p.doc, p.panel, null, p.toggle)).toBe('toggle')
    expect(returnFocus(p.doc, p.panel, p.toggle, p.toggle)).toBe('toggle')
    expect(p.toggle.focus, 'the button is focused by the caller once shown, not while aria-hidden').not.toHaveBeenCalled()
    const gone = p.el()
    gone.isConnected = false
    expect(returnFocus(p.doc, p.panel, gone, p.toggle)).toBe('toggle')
    expect(gone.focus).not.toHaveBeenCalled()
    const disabled = p.el(false)
    expect(returnFocus(p.doc, p.panel, disabled, p.toggle)).toBe('toggle')
  })

  it('leaves a focus the reader moved elsewhere while the chat was open', () => {
    const p = page()
    p.raw.activeElement = p.elsewhere
    expect(returnFocus(p.doc, p.panel, p.field, p.toggle)).toBe('stay')
    expect(p.field.focus).not.toHaveBeenCalled()
    expect(p.raw.activeElement).toBe(p.elsewhere)
  })
})

// The browser parts the unit tests cannot run (no DOM here); floating-context.spec.ts presses the key in Chromium.
describe('the floating chat shortcut is wired where the button is', () => {
  it('Layout draws the floating chat, and so its listener, only while AI is on', () => {
    expect(layoutSrc).toContain('{aiOn && <FloatingAIChat />}')
  })

  it('is listened for only by the floating chat', () => {
    const src = join(process.cwd(), 'src')
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /\b(useChatShortcut|listenForChatShortcut)\(/.test(readFileSync(p, 'utf8'))) callers.push(relative(src, p))
      }
    }
    walk(src)
    expect(callers.sort()).toEqual(['components/FloatingAIChat/index.tsx', 'hooks/useChatShortcut.ts'])
  })

  it('opens and closes through the button’s and the window’s own paths, and not on the AI Chat page', () => {
    expect(indexSrc).toContain("useChatShortcut(pageType !== 'ai-chat', () => (isOpen ? close() : open()))")
    expect(indexSrc).toContain('<ToggleButton onClick={open}')
    expect(indexSrc).toContain('onClose={close}')
    expect([indexSrc.match(/setIsOpen\(/g)?.length, indexSrc.match(/useState\(/g)?.length], 'one open state, set in open and close only').toEqual([2, 4])
  })

  it('opens with the focus in the input', () => {
    const effect = chatPanelSrc.slice(chatPanelSrc.indexOf('const inputRef = useRef'), chatPanelSrc.indexOf('const handleKeyDown'))
    expect(effect).toMatch(/if \(!visible\) return[\s\S]*inputRef\.current\?\.focus\(\)[\s\S]*\}, \[visible\]\)/)
    expect(chatPanelSrc).toContain('inputRef={inputRef}')
  })
})
