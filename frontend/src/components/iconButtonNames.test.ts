import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { ResourceModal } from '@/pages/dashboard/modals/ResourceModal'

// A button that shows only the X icon (close a window or a panel, clear a search, cancel an edit) has a name a screen
// reader says and a test finds it by: the icon is aria-hidden, so without aria-label the button is "button". The
// Dashboard's list windows closed with such a button.

vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))

const SRC = join(process.cwd(), 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return e.name.endsWith('.tsx') ? [path] : []
  })
}

// the opening tag of the element at `at`: up to the first > outside braces
function openingTag(src: string, at: number): string {
  let depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(at, i + 1)
  }
  return src.slice(at)
}

const X_ICON = /<(X|XIcon|XCircle|CircleX)\b[^>]*\/>/
const NAMED = /\saria-label(ledby)?=|\stitle=/

// "file:line" of each <button> whose only content is an X icon and that has no aria-label, aria-labelledby or title
function unnamedXButtons(): string[] {
  const out: string[] = []
  for (const file of sources(SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/<button\b/g)) {
      const open = openingTag(src, m.index)
      const end = src.indexOf('</button>', m.index + open.length)
      if (end < 0) continue
      const inner = src.slice(m.index + open.length, end)
      if (inner.includes('<button') || !X_ICON.test(inner)) continue
      const text = inner.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<[A-Z][\w.]*\b[^>]*\/>/g, '').trim()
      if (text === '' && !NAMED.test(open)) out.push(`${relative(SRC, file)}:${src.slice(0, m.index).split('\n').length}`)
    }
  }
  return out
}

const i18n = { en: i18next.createInstance(), ko: i18next.createInstance() }
beforeAll(async () => {
  await i18n.en.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
  await i18n.ko.use(initReactI18next).init({ lng: 'ko', resources: { ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

// the Pods window of the Dashboard with a search typed
const windowOf = (lng: 'en' | 'ko') =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n[lng] }, createElement(ResourceModal, {
    selectedResourceType: 'pods', onClose: () => {}, selectedStat: undefined, isLoading: false, resourceCount: 1,
    searchQuery: 'web', setSearchQuery: () => {}, filteredResources: [], serverPage: { total: 0, page: 1, setPage: () => {} },
  })))

// the window's buttons drawn with the X icon, each as its aria-label or "(none)"
const xButtons = (html: string) => [...html.matchAll(/<button([^>]*)>(?:(?!<\/button>).)*lucide-x[ "](?:(?!<\/button>).)*<\/button>/g)]
  .map((b) => b[1].match(/aria-label="([^"]*)"/)?.[1] ?? '(none)')

describe('buttons that show only the X icon', () => {
  it('name what they do in every source file', () => {
    expect(unnamedXButtons()).toEqual([])
  })

  it('the Dashboard list window names its close and its search clearing, in English and Korean', () => {
    expect(xButtons(windowOf('en'))).toEqual([en.common.close, en.common.clearSearch])
    expect(xButtons(windowOf('ko'))).toEqual([ko.common.close, ko.common.clearSearch])
  })
})
