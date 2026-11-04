import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '../../../i18n/locales/en.json'
import type { VPAInfo } from '@/services/api'
import { VPATable } from './VPATable'
import { vpaCount } from './vpaHelpers'
import { normalizeWatchVPAObject } from './vpaWatchNormalize'

// The VPA list shows the CRD's wide columns MinReplicas and OOMSeconds (VPA 1.7, spec.updatePolicy.minReplicas and
// evictAfterOOMSeconds), from the server's row and from a live update's object.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', defaultNS: 'translation', resources: { en: { translation: en } }, interpolation: { escapeValue: false },
  })
})

const vpa = (name: string, more: Partial<VPAInfo> = {}): VPAInfo => ({
  name, namespace: 'shop', target_ref: 'Deployment/web', target_ref_kind: 'Deployment', target_ref_name: 'web', update_mode: 'Off',
  cpu_target: '25m', memory_target: '64Mi', provided: 'True', created_at: '2026-11-04T01:02:03Z', ...more,
})

const tr = (key: string, fallback: string, o?: Record<string, unknown>) => i18n.t(key, { defaultValue: fallback, ...o })
const render = (rows: VPAInfo[], isLoading: boolean, showNamespaceColumn: boolean) => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
  createElement(QueryClientProvider, { client: new QueryClient() }, createElement(VPATable, {
    pagedVPAs: rows, sortedVPAsLength: rows.length, isLoading, showNamespaceColumn, sortKey: null, setSortKey: () => {}, sortDir: 'asc',
    setSortDir: () => {}, currentPage: 1, setCurrentPage: () => {}, totalPages: 1, rowsPerPage: 25, tableContainerRef: createRef<HTMLDivElement>(),
    tableBodyRef: createRef<HTMLDivElement>(), theadRef: createRef<HTMLTableSectionElement>(), firstRowRef: createRef<HTMLTableRowElement>(), openDetail: () => {}, tr,
  }))))

function table(rows: VPAInfo[], showNamespaceColumn = false) {
  const html = render(rows, false, showNamespaceColumn)
  const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const heads = [...(html.split('<thead')[1] ?? '').split('</thead>')[0].matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]))
  const body = (html.split('<tbody')[1] ?? '').split('</tbody>')[0]
  const cells = [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => text(c[1])))
  return { heads, cells }
}

describe('VPA list', () => {
  it('Min Replicas and OOM Seconds after Provided, the VPA\'s value or "-"', () => {
    const { heads, cells } = table([vpa('a', { min_replicas: 2, evict_after_oom_seconds: 300 }), vpa('b', { min_replicas: null }), vpa('c')])
    expect(heads).toEqual(['Name', 'Reference', 'Mode', 'CPU', 'Memory', 'Provided', 'Min Replicas', 'OOM Seconds', 'Age'])
    expect(cells.map((r) => r.slice(5, 8))).toEqual([['True', '2', '300'], ['True', '-', '-'], ['True', '-', '-']])
  })

  it('the loading and the empty row span every column, the namespace one too', () => {
    const spans = (isLoading: boolean) => render([], isLoading, true).match(/colSpan="\d+"/gi)
    expect(spans(true)).toEqual(['colSpan="10"'])
    expect(spans(false)).toEqual(['colSpan="10"'])
    expect(table([vpa('a')], true).heads).toHaveLength(10)
  })

  it('a live update\'s object gives the same two values', () => {
    const raw = (updatePolicy: Record<string, unknown>) => ({ metadata: { name: 'web', namespace: 'shop' }, spec: { targetRef: { kind: 'Deployment', name: 'web' }, updatePolicy } })
    const row = normalizeWatchVPAObject(raw({ updateMode: 'InPlace', minReplicas: 2, evictAfterOOMSeconds: 300 }))
    expect([row.min_replicas, row.evict_after_oom_seconds, row.update_mode]).toEqual([2, 300, 'InPlace'])
    const bare = normalizeWatchVPAObject(raw({ updateMode: 'Off' }))
    expect([bare.min_replicas, bare.evict_after_oom_seconds]).toEqual([null, null])
  })

  it('vpaCount: the number as written, "-" when left out', () => {
    expect([2, 0, 300, null, undefined].map(vpaCount)).toEqual(['2', '0', '300', '-', '-'])
  })
})
