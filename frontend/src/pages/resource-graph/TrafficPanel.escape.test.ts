import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '../../i18n/locales/en.json'
import type { TrafficLine, TrafficResult } from '@/services/api'
import { modalOpen } from '@/hooks/useModalStack'
import { TrafficPanel } from './TrafficPanel'

// The Resource Graph's traffic panel closed only on its X. It closes on Escape through usePanelEscape (whose
// behaviour, the window or drawer over it first, useDismiss.test.ts holds): it hands it the line pressed, its close
// and the modal stack, so the check window and an end's drawer opened from it take the first Escape.
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

const line: TrafficLine = {
  from: { namespace: 'flows-demo', kind: 'Deployment', name: 'stranger' },
  to: { namespace: 'flows-demo', kind: 'Deployment', name: 'web' },
  allowed: 0,
  dropped: 3,
  ports: [{ protocol: 'TCP', port: 80 }],
}
const result: TrafficResult = { available: true, source: 'relay', namespaces: ['flows-demo'], since: '5m', lines: [line] }

describe('Resource Graph traffic panel on Escape', () => {
  it('hands its line, its close and the modal stack to usePanelEscape', () => {
    const opener = { current: { focus: () => {} } }
    const onClose = () => {}
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(TrafficPanel, { line, result, opener, onClose, onWhy: () => {}, onOpen: () => {} })))
    expect(html).toContain('data-testid="traffic-panel"')
    expect(calls).toHaveLength(1)
    const [open, givenOpener, close, covered] = calls[0]
    expect(open).toBe(true)
    expect(givenOpener).toBe(opener)
    expect(close).toBe(onClose)
    expect(covered).toBe(modalOpen)
  })
})
