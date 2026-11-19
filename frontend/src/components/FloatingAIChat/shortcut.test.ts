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
import { focusChat, focusOrigin, returnFocus, shortcutStep } from './focusReturn'
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

  it('opens, closes or brings the focus in through the button’s and the window’s own paths, and not on the AI Chat page', () => {
    const wiring = indexSrc.slice(indexSrc.indexOf("useChatShortcut(pageType !== 'ai-chat', () => {"))
    expect(wiring).toMatch(/^useChatShortcut\(pageType !== 'ai-chat', \(\) => \{\s+const step = shortcutStep\(isOpen, document, panelRef\.current\)\s+if \(step === 'open'\) open\(\)\s+else if \(step === 'close'\) close\(\)\s+else focusIn\(\)\s+\}\)/)
    const focusIn = indexSrc.slice(indexSrc.indexOf('const focusIn = useCallback'), indexSrc.indexOf('useChatShortcut('))
    expect(focusIn, 'what had the focus is where closing gives it back, once the chat took it').toMatch(/const from = focusOrigin\(document\)\s+if \(focusChat\(document, inputRef\.current, panelRef\.current\) !== 'none'\) openedFrom\.current = from/)
    expect(indexSrc).toContain('<ToggleButton onClick={open}')
    expect(indexSrc).toContain('onClose={close}')
    expect(indexSrc).toContain('inputRef={inputRef}')
    expect([indexSrc.match(/setIsOpen\(/g)?.length, indexSrc.match(/useState\(/g)?.length], 'one open state, set in open and close only').toEqual([2, 4])
  })

  it('opens with the focus in the input, the one the shortcut focuses', () => {
    const effect = chatPanelSrc.slice(chatPanelSrc.indexOf('const ownInput = useRef'), chatPanelSrc.indexOf('const handleKeyDown'))
    expect(effect).toContain('const inputRef = givenInput ?? ownInput')
    expect(effect).toMatch(/if \(!visible\) return[\s\S]*inputRef\.current\?\.focus\(\)[\s\S]*\}, \[visible, inputRef\]\)/)
    expect(chatPanelSrc).toContain('inputRef={inputRef}')
  })
})

// The first press while the chat is open and the focus is elsewhere (a drawer, a window, the page) closed the chat, and
// only a second one opened it again with the focus in its input. Now that press brings the focus in.
describe('the shortcut while the chat is open', () => {
  // the chat's window (which can take the focus, tabIndex -1) holding its input
  function chatPage() {
    const p = page()
    const el = p.el()
    const box = Object.assign(el, { contains: (n: unknown) => n === p.input || n === el })
    return { ...p, box }
  }

  it('opens the closed chat, wherever the focus is', () => {
    const p = chatPage()
    p.raw.activeElement = p.input
    expect(shortcutStep(false, p.doc, p.box)).toBe('open')
    expect(shortcutStep(false, p.doc, null)).toBe('open')
  })

  it('closes the chat the focus is in, its input or the window itself', () => {
    const p = chatPage()
    p.raw.activeElement = p.input
    expect(shortcutStep(true, p.doc, p.box)).toBe('close')
    p.raw.activeElement = p.box
    expect(shortcutStep(true, p.doc, p.box)).toBe('close')
  })

  it('brings the focus in from a drawer, a window or the page, also before the window is drawn', () => {
    const p = chatPage()
    const outside: [string, object | null][] = [['a drawer control', p.field], ['a window control', p.elsewhere], ['the page', p.raw.body], ['nothing', null]]
    for (const [where, el] of outside) {
      p.raw.activeElement = el
      expect(shortcutStep(true, p.doc, p.box), `focus on ${where}`).toBe('focus')
    }
    p.raw.activeElement = p.field
    expect(shortcutStep(true, p.doc, null), 'the window not drawn yet').toBe('focus')
  })

  it('focuses the input, else the window while the input takes none, else nothing', () => {
    const p = chatPage()
    p.raw.activeElement = p.field
    expect(focusChat(p.doc, p.input, p.box)).toBe('input')
    expect(p.raw.activeElement).toBe(p.input)

    const q = chatPage()
    q.raw.activeElement = q.field
    const disabled = q.el(false)
    expect(focusChat(q.doc, disabled, q.box), 'a conversation being made: the input is disabled').toBe('window')
    expect(q.raw.activeElement).toBe(q.box)

    const r = chatPage()
    r.raw.activeElement = r.field
    expect(focusChat(r.doc, null, null), 'the window is still loading').toBe('none')
    expect(r.raw.activeElement).toBe(r.field)
  })

  it('gives the focus back, as the chat closes, to where the press found it', () => {
    const p = chatPage()
    // the chat opened from the field; the reader went on in a drawer control (elsewhere) with the chat still open
    p.raw.activeElement = p.elsewhere
    const from = focusOrigin(p.doc)
    expect(shortcutStep(true, p.doc, p.box)).toBe('focus')
    expect(focusChat(p.doc, p.input, p.box)).toBe('input')
    // Escape (or the shortcut again) in the input closes it
    expect(shortcutStep(true, p.doc, p.box)).toBe('close')
    expect(returnFocus(p.doc, p.box, from, p.toggle)).toBe('back')
    expect(p.raw.activeElement).toBe(p.elsewhere)
  })
})
