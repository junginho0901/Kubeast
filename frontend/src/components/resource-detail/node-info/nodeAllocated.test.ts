import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '../../../i18n/locales/en.json'
import ko from '../../../i18n/locales/ko.json'
import { PageContextProvider } from '@/components/PageContextProvider'
import NodeInfo from '../NodeInfo'
import { nodeAllocatedView, readyChangedAt } from './nodeAllocated'

const ROWS = [
  { resource: 'cpu', requests: '950m (23%)', limits: '2 (50%)' },
  { resource: 'memory', requests: '290Mi (1%)', limits: '0 (0%)' },
  { resource: 'nvidia.com/gpu', requests: '2', limits: '2' },
]

describe('a node\'s allocated resources', () => {
  it('are the rows the server read', () => {
    expect(nodeAllocatedView({ allocated_resources: ROWS })).toEqual({ rows: ROWS })
  })

  it('say why they are missing when the pods could not be read, and show no rows', () => {
    expect(nodeAllocatedView({ allocated_error: 'pods is forbidden' })).toEqual({ rows: [], error: 'pods is forbidden' })
  })

  it('name the namespaces of a grant limited to them', () => {
    expect(nodeAllocatedView({ allocated_resources: ROWS, allocated_scope: ['a', 'b'] })).toEqual({ rows: ROWS, scope: ['a', 'b'] })
  })

  it('a node answer without them has no rows and no reason', () => {
    expect(nodeAllocatedView({})).toEqual({ rows: [] })
    expect(nodeAllocatedView(undefined)).toEqual({ rows: [] })
  })
})

describe('the Node drawer', () => {
  const i18n = i18next.createInstance()
  beforeAll(async () => {
    await i18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      ns: ['translation', 'detail'],
      defaultNS: 'translation',
      resources: { en: { translation: en, detail: {} }, ko: { translation: ko, detail: (ko as { detail: Record<string, string> }).detail } },
      interpolation: { escapeValue: false },
    })
  })
  const NODE = {
    name: 'n1', labels: {}, annotations: {}, taints: [], addresses: [], capacity: {}, allocatable: {},
    conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady', last_transition_time: '2026-11-06T10:00:00Z' }],
  }
  const render = (lng: string, describeAnswer: Record<string, unknown>) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['cluster', 'nodes', 'describe', 'n1'], describeAnswer)
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
      createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(NodeInfo, { name: 'n1' }))))))
  }
  const section = (html: string, title: string) => {
    const at = html.indexOf(`>${title}</p>`)
    if (at < 0) return `no ${title} section`
    const next = html.indexOf('<div class="rounded-lg border', at)
    return html.slice(at, next < 0 ? undefined : next)
  }
  const cells = (part: string) => [...part.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1])).filter((r) => r.length)

  it('lists the allocated resources under kubectl\'s columns', () => {
    const part = section(render('en', { ...NODE, allocated_resources: ROWS }), 'Allocated Resources')
    expect(cells(part)).toEqual(ROWS.map((r) => [r.resource, r.requests, r.limits]))
    expect(part).toContain('Total limits may be over 100 percent')
  })

  it('says why when the pods could not be read, not a table of zeros', () => {
    const part = section(render('en', { ...NODE, allocated_error: 'pods is forbidden' }), 'Allocated Resources')
    expect(cells(part)).toEqual([])
    expect(part).toContain('pods is forbidden')
  })

  it('says a grant limited to namespaces counts only those', () => {
    const part = section(render('en', { ...NODE, allocated_resources: ROWS, allocated_scope: ['a'] }), 'Allocated Resources')
    expect(part).toContain('only the pods in your namespaces (a)')
    expect(part).toContain('data-testid="node-allocated-scope"')
  })

  it('reads in Korean', () => {
    const html = render('ko', { ...NODE, allocated_resources: ROWS, allocated_scope: ['a'] })
    expect(html).toContain('할당된 리소스')
    expect(html).toContain('네임스페이스')
  })

  it('names the time since the Ready condition changed for what it is, not an uptime', () => {
    for (const [lng, word] of [['en', 'Since Ready Changed'], ['ko', 'Ready 변경 후']]) {
      const html = render(lng, NODE)
      expect(html, lng).toContain(word)
      expect(html, lng).not.toMatch(/Uptime|가동 시간/)
    }
    expect(readyChangedAt(NODE.conditions)).toBe('2026-11-06T10:00:00Z')
    expect(readyChangedAt([{ type: 'MemoryPressure', last_transition_time: 'x' }])).toBeUndefined()
    expect(readyChangedAt(undefined)).toBeUndefined()
  })

  it('tells the floating chat the same rows and time', () => {
    const src = readFileSync(fileURLToPath(new URL('./useNodeData.ts', import.meta.url)), 'utf8')
    expect(src).toContain('allocated: nodeAllocatedView(nodeDescribe)')
    expect(src).toContain('ready_changed_at: readyChangedAt(conditions)')
    // the pods on screen read kubectl's Status there too
    expect(src).toContain('status: p.status,')
  })
})
