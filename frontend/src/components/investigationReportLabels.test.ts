import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { Investigation } from '@/services/api/investigations'

vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))

import InvestigationReportModal from './InvestigationReportModal'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const report = (labels: Record<string, string>, annotations: Record<string, string>) => ({
  id: 'inv-1', alertname: 'KubePodCrashLooping', cluster: 'self', namespace: 'shop', severity: 'warning', status: 'completed',
  received_at: '2026-11-23T02:00:00Z', model: '', prompt_tokens: null, completion_tokens: null, iterations: 1, duration_ms: 1000,
  repeat_count: 0, error: '', report: '', result: null, labels, annotations, generator_url: '', alertmanager_url: '', tool_calls: [],
}) as unknown as Investigation

const render = async (labels: Record<string, string>, annotations: Record<string, string>, lng = 'en') => {
  await i18n.changeLanguage(lng)
  const qc = new QueryClient()
  qc.setQueryData(['investigations', 'one', 'inv-1'], report(labels, annotations))
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(I18nextProvider, { i18n },
    createElement(InvestigationReportModal, { id: 'inv-1', load: async () => report(labels, annotations), onClose: () => {} }))))
}
const values = (html: string) => [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map((m) => [m[1], m[2]])

describe("an investigation report's labels and annotations", () => {
  it('draw an empty value as -', async () => {
    expect(values(await render({ alertname: 'KubePodCrashLooping', team: '' }, { summary: 's', runbook_url: '' })))
      .toEqual([['alertname', 'KubePodCrashLooping'], ['team', '-'], ['summary', 's'], ['runbook_url', '-']])
  })

  it('say None for no annotations, in both languages', async () => {
    expect(await render({ alertname: 'A' }, {})).toContain('<div class="text-slate-500">None</div>')
    expect(await render({ alertname: 'A' }, {}, 'ko')).toContain(`<div class="text-slate-500">${ko.common.none}</div>`)
    expect(await render({ alertname: 'A' }, {})).not.toContain('No annotations')
  })
})
