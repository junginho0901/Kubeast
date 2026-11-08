import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { PVInfo } from '@/services/api'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { PVTable } from './PVTable'
import { normalizeWatchPvObject } from './pvWatchNormalize'
import { pvToRawJson } from './pvHelpers'

const tr = (_key: string, fallback: string) => fallback
const pv = (fields: Partial<PVInfo>): PVInfo => ({ name: 'vol', status: 'Failed', capacity: '1Gi', access_modes: ['ReadWriteOnce'], reclaim_policy: 'Retain', created_at: '', ...fields })

const render = (pvs: PVInfo[]) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PVTable, {
  pagedPVs: pvs,
  sortedPVsLength: pvs.length,
  isLoading: false,
  sortKey: null,
  setSortKey: () => {},
  sortDir: 'asc',
  setSortDir: () => {},
  currentPage: 1,
  setCurrentPage: () => {},
  totalPages: 1,
  rowsPerPage: pvs.length,
  tableContainerRef: createRef<HTMLDivElement>(),
  tableBodyRef: createRef<HTMLDivElement>(),
  theadRef: createRef<HTMLTableSectionElement>(),
  firstRowRef: createRef<HTMLTableRowElement>(),
  openDetail: () => {},
  tr,
})))

const heads = (html: string) => [...html.matchAll(/<th[^>]*>.*?<span[^>]*>(.*?)<\/span>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''))
const firstRow = (html: string) => [...html.split('<tbody')[1].split('</tr>')[0].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''))

// `kubectl get pv` prints why a volume failed next to its phase; the list says the same.
describe('the PersistentVolumes table', () => {
  it('has a Reason column with what the status says, as kubectl prints it', () => {
    const html = render([pv({ reason: 'VolumeFailedDelete', message: 'the backend refused' })])
    const at = heads(html).indexOf('Reason')
    expect(at).toBeGreaterThan(-1)
    expect(firstRow(html)[at]).toBe('VolumeFailedDelete')
  })

  it('shows - for a volume with no reason', () => {
    const html = render([pv({ status: 'Bound' })])
    expect(firstRow(html)[heads(html).indexOf('Reason')]).toBe('-')
  })

  it('counts the column in its empty row and its filler rows', () => {
    expect(heads(render([]))).toHaveLength(11)
    expect(render([])).toContain('colSpan="11"')
  })

  it('names the column in both languages', () => {
    expect(en.pvs.table.reason).toBe('Reason')
    expect(ko.pvs.table.reason).toBe('사유')
  })
})

describe('a PersistentVolume row', () => {
  it('keeps the reason and the message from a raw object, for a live update', () => {
    const row = normalizeWatchPvObject({ metadata: { name: 'vol' }, spec: {}, status: { phase: 'Failed', reason: 'VolumeFailedDelete', message: 'the backend refused' } })
    expect([row.reason, row.message]).toEqual(['VolumeFailedDelete', 'the backend refused'])
  })

  it('hands the reason and the message to the drawer', () => {
    expect(pvToRawJson(pv({ reason: 'VolumeFailedDelete', message: 'the backend refused' })).status).toEqual({ phase: 'Failed', reason: 'VolumeFailedDelete', message: 'the backend refused' })
  })
})
