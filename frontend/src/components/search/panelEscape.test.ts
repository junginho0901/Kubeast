import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '../../i18n/locales/en.json'
import ResourceTypePicker from './ResourceTypePicker'
import SearchSettings from './SearchSettings'

// The Advanced Search toolbar's panels that close on a press outside close on Escape too (usePanelEscape, whose
// behaviour useDismiss.test.ts holds): each panel hands it its open state, its setter and its button's ref.
const calls = vi.hoisted(() => [] as unknown[][])
vi.mock('@/hooks/useDismiss', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDismiss')>()),
  usePanelEscape: (...args: unknown[]) => { calls.push(args) },
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})
beforeEach(() => { calls.length = 0 })

const render = <P extends object>(component: FunctionComponent<P>, props: P) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(component, props)))

describe('Advanced Search toolbar panels on Escape', () => {
  it.each([
    ['Select Resources', () => render(ResourceTypePicker, { selected: new Set<string>(), onChange: () => {} })],
    ['Settings', () => render(SearchSettings, { maxItemsPerResource: 10000, setMaxItemsPerResource: () => {}, refetchIntervalMs: 0, setRefetchIntervalMs: () => {} })],
  ])('%s hands its closed state, its button and its setter to usePanelEscape', (name, draw) => {
    const html = draw()
    expect(html).toContain(name)
    expect(calls).toHaveLength(1)
    const [open, opener, setOpen] = calls[0]
    expect(open).toBe(false)
    expect(opener).toEqual({ current: null })
    expect(typeof setOpen).toBe('function')
  })
})
