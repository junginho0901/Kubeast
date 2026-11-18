import { describe, expect, it } from 'vitest'
import pageSource from '@/pages/AdvancedSearch.tsx?raw'
import type { SearchResult } from './searchEngine'
import { searchLayer, searchShown, type Searched } from './searchShown'

// Advanced Search runs an expression over the objects it read, a moment after it is typed. Until that search ends, the
// results of the expression before stay what they were: theirs, not the new expression's.

const result = (name: string, namespace = 'shop'): SearchResult => ({ kind: 'Pod', name, namespace, status: 'Running', raw: { apiVersion: 'v1' } })
const readOf = (namespace: string) => ({ items: [{ metadata: { name: 'web' } }, { metadata: { name: 'db' } }], namespace, types: ['pods'] })
const shopRead = readOf('shop')
const searchedOf = (query: string, read = shopRead, results = [result('web')]): Searched => ({
  query, over: read, namespace: read.namespace, types: read.types, results, timeMs: 3,
})
const RUNNING = "status.phase === 'Running'"
const PENDING = "status.phase === 'Pending'"

describe('what Advanced Search shows', () => {
  it('is the results of the expression in the box, over the objects read now', () => {
    expect(searchShown(searchedOf(RUNNING), RUNNING, shopRead)).toEqual({ state: 'done', results: [result('web')], timeMs: 3 })
  })

  it('is searching, not the results of the expression before, until the new one is searched', () => {
    expect(searchShown(searchedOf(RUNNING), PENDING, shopRead)).toEqual({ state: 'searching' })
    expect(searchShown(null, PENDING, shopRead)).toEqual({ state: 'searching' })
  })

  it('is searching again over a new read of the objects (another namespace, a refresh)', () => {
    expect(searchShown(searchedOf(RUNNING), RUNNING, readOf('payments'))).toEqual({ state: 'searching' })
  })

  it('is why the expression could not be read, not 0 results, until another expression is searched', () => {
    const unreadable = { ...searchedOf('!!data', shopRead, []), unreadable: 'Unexpected operator' }
    expect(searchShown(unreadable, '!!data', shopRead)).toEqual({ state: 'unreadable', reason: 'Unexpected operator' })
    expect(searchShown(unreadable, 'data != null', shopRead)).toEqual({ state: 'searching' })
    expect(searchShown(unreadable, '!!data', readOf('payments'))).toEqual({ state: 'searching' })
  })

  it('is nothing with an empty box or nothing read to search', () => {
    expect(searchShown(searchedOf(RUNNING), '  ', shopRead)).toEqual({ state: 'idle' })
    expect(searchShown(searchedOf(RUNNING), RUNNING, undefined)).toEqual({ state: 'idle' })
    expect(searchShown(searchedOf(RUNNING), RUNNING, { items: [] })).toEqual({ state: 'idle' })
  })
})

describe('what Advanced Search tells the floating chat', () => {
  const now = (namespace: string, read: Parameters<typeof searchLayer>[2]['read']) => ({ namespace, types: ['pods'], read })

  it('gives the results with the expression they answer, and the one in the box as still searched', () => {
    const data = searchLayer(searchedOf(RUNNING), PENDING, now('shop', shopRead))?.data as Record<string, any>
    expect(data.query).toBe(RUNNING)
    expect(data.total).toBe(1)
    expect(data.top_results.map((r: { name: string }) => r.name)).toEqual(['web'])
    expect(data.searching).toEqual({ query: PENDING, namespace: 'shop', selected_resource_types: ['pods'] })
  })

  it('gives the namespace the results were found in, not the one picked since', () => {
    const data = searchLayer(searchedOf(RUNNING), RUNNING, now('payments', undefined))?.data as Record<string, any>
    expect(data.namespace).toBe('shop')
    expect(data.searching).toEqual({ query: RUNNING, namespace: 'payments', selected_resource_types: ['pods'] })
  })

  it('says nothing is under way once the results answer the box', () => {
    const data = searchLayer(searchedOf(RUNNING), RUNNING, now('shop', shopRead))?.data as Record<string, any>
    expect(data).toMatchObject({ query: RUNNING, namespace: 'shop', total: 1 })
    expect(data.searching).toBeUndefined()
  })

  it('gives no earlier result for a read that listed nothing, and nothing for an empty box', () => {
    expect(searchLayer(searchedOf(RUNNING), PENDING, now('empty', { items: [] }))?.data).toEqual({
      query: PENDING, namespace: 'empty', selected_resource_types: ['pods'], total: 0, by_kind: {}, top_results: [],
    })
    expect(searchLayer(searchedOf(RUNNING), '', now('shop', shopRead))).toBeNull()
    expect(searchLayer(null, PENDING, now('shop', shopRead))?.data).toEqual({ query: PENDING, namespace: 'shop', selected_resource_types: ['pods'], searching: true })
  })

  it('says why the expression in the box could not be read, with no count', () => {
    const unreadable = { ...searchedOf('!!data', shopRead, []), unreadable: 'Unexpected operator' }
    const layer = searchLayer(unreadable, '!!data', now('shop', shopRead))
    expect(layer?.summary).toBe('고급 검색 — 쿼리: "!!data" 식을 읽지 못했습니다: Unexpected operator')
    expect(layer?.data).toEqual({ query: '!!data', namespace: 'shop', selected_resource_types: ['pods'], expression_unreadable: 'Unexpected operator' })
  })

  it('tells no 0 for an expression that could not be read while another is searched', () => {
    const unreadable = { ...searchedOf('!!data', shopRead, []), unreadable: 'Unexpected operator' }
    expect(searchLayer(unreadable, 'data != null', now('shop', shopRead))?.data).toEqual({
      query: 'data != null', namespace: 'shop', selected_resource_types: ['pods'], searching: true,
    })
  })

  it('says the types the read failed when every list failed, not a complete 0', () => {
    const failedRead = { items: [], errors: [{ type: 'pods', error: 'pods is forbidden' }, { type: 'services', error: 'etcdserver: request timed out' }], cut: [] }
    const layer = searchLayer(null, RUNNING, { namespace: '', types: ['pods', 'services'], read: failedRead })
    expect(layer?.summary).toBe(`고급 검색 0건 — 쿼리: "${RUNNING}" · 2개 종류 실패: pods, services`)
    expect(layer?.data).toMatchObject({
      total: 0, complete: false,
      failed_types: [{ type: 'pods', reason: 'pods is forbidden' }, { type: 'services', reason: 'etcdserver: request timed out' }],
    })
  })

  it('says the types cut or failed in the read the results went over, and in the read still searched', () => {
    const cutRead = { ...shopRead, errors: [], cut: [{ type: 'pods', limit: 2, remaining: 5 }] }
    const done = searchLayer(searchedOf(RUNNING, cutRead), RUNNING, now('shop', cutRead))
    expect(done?.summary).toContain(' · 처음 2개만 읽은 종류: pods')
    expect(done?.data).toMatchObject({ total: 1, complete: false, cut_types: [{ type: 'pods', first: 2, of: 7 }] })
    const failedRead = { ...shopRead, errors: [{ type: 'services', error: 'timed out', loaded: 0 }], cut: [] }
    expect(searchLayer(null, RUNNING, now('shop', failedRead))?.data).toMatchObject({
      searching: true, complete: false, failed_types: [{ type: 'services', reason: 'timed out', read_before_failure: 0 }],
    })
  })

  it('is what the page shows and tells', () => {
    expect(pageSource).toContain('const shown = searchShown(deferredSearched, deferredQuery, fetchResult)')
    expect(pageSource).toContain("searchLayer(searched, rawQuery, { namespace, types: Array.from(selectedResources), read: fetchResult })")
    expect(pageSource).toContain('<SearchResultTable results={shownResults} />')
    expect(pageSource).toContain("shown.state === 'unreadable' && (")
    expect(pageSource).toContain("t('advancedSearch.unreadable', 'The expression could not be read: {{reason}}', { reason: shown.reason })")
    expect(pageSource).toContain("resultCount={deferredQuery.trim() && shown.state !== 'unreadable' ? shownResults.length : null}")
    expect(pageSource).toContain("shown.state === 'done' && shown.results.length === 0 && (")
  })
})
