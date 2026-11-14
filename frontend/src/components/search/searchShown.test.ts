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

  it('is nothing with an empty box or nothing read to search', () => {
    expect(searchShown(searchedOf(RUNNING), '  ', shopRead)).toEqual({ state: 'idle' })
    expect(searchShown(searchedOf(RUNNING), RUNNING, undefined)).toEqual({ state: 'idle' })
    expect(searchShown(searchedOf(RUNNING), RUNNING, { items: [] })).toEqual({ state: 'idle' })
  })
})

describe('what Advanced Search tells the floating chat', () => {
  const now = (namespace: string, read: { items: unknown[] } | undefined) => ({ namespace, types: ['pods'], read })

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

  it('is what the page shows and tells', () => {
    expect(pageSource).toContain('const shown = searchShown(deferredSearched, deferredQuery, fetchResult)')
    expect(pageSource).toContain("searchLayer(searched, rawQuery, { namespace, types: Array.from(selectedResources), read: fetchResult })")
    expect(pageSource).toContain('<SearchResultTable results={shownResults} />')
  })
})
