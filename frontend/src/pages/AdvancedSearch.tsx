import { useState, useEffect, useDeferredValue, useCallback, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Search, RefreshCw, AlertCircle, Database, AlertTriangle, Loader2 } from 'lucide-react'
import { api } from '@/services/api'
import ResourceTypePicker, { ResourceTypeOption, NON_LISTABLE } from '@/components/search/ResourceTypePicker'
import SearchQueryEditor from '@/components/search/SearchQueryEditor'
import SearchResultTable from '@/components/search/SearchResultTable'
import SearchExamples from '@/components/search/SearchExamples'
import SearchSettings from '@/components/search/SearchSettings'
import { searchWithExpression, toSearchResult, SearchResult } from '@/components/search/searchEngine'

const STORAGE_KEY_RESOURCES = 'advanced-search-resources'

export default function AdvancedSearch() {
  const { t } = useTranslation()

  const [selectedResources, setSelectedResources] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_RESOURCES)
      if (stored) {
        const parsed = JSON.parse(stored) as string[]
        const cleaned = parsed.filter(r => !NON_LISTABLE.has(r))
        return new Set(cleaned.length > 0 ? cleaned : ['pods', 'deployments', 'services'])
      }
      return new Set(['pods', 'deployments', 'services'])
    } catch { return new Set(['pods', 'deployments', 'services']) }
  })

  const [rawQuery, setRawQuery] = useState('')

  const [namespace, setNamespace] = useState<string>('')
  const [maxItemsPerResource, setMaxItemsPerResource] = useState(10_000)
  const [refetchIntervalMs, setRefetchIntervalMs] = useState(0)
  const failedTypesRef = useRef(new Set<string>())

  const deferredQuery = useDeferredValue(rawQuery)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_RESOURCES, JSON.stringify([...selectedResources]))
    failedTypesRef.current.clear()
  }, [selectedResources])

  // Fetch namespace list
  const { data: namespaces } = useQuery({
    queryKey: ['search-namespaces'],
    queryFn: () => api.getNamespaces(),
    staleTime: 30_000,
  })

  // Fetch dynamic API resources for the picker
  const { data: apiResources } = useQuery({
    queryKey: ['search-api-resources'],
    queryFn: () => api.getApiResources(),
    staleTime: 120_000,
  })

  const extraResources = useMemo<ResourceTypeOption[]>(() => {
    if (!apiResources || !Array.isArray(apiResources)) return []
    return apiResources
      .filter((r: any) => r.name && r.kind)
      .map((r: any) => ({
        name: r.name as string,
        kind: r.kind as string,
        group: (r.group_version?.split('/')[0]) ?? 'core',
        namespaced: r.namespaced ?? true,
        verbs: (r.verbs ?? []) as string[],
      }))
  }, [apiResources])

  const resourceTypes = useMemo(() => [...selectedResources], [selectedResources])

  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  // Fetch resources
  const {
    data: fetchResult,
    isLoading: isLoadingResources,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['search-resources', resourceTypes.sort().join(','), namespace, maxItemsPerResource],
    queryFn: async ({ signal }) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      signal?.addEventListener('abort', () => controller.abort())

      const items: Record<string, unknown>[] = []
      const errors: { type: string; error: string }[] = []

      const typesToFetch = resourceTypes.filter(t => !failedTypesRef.current.has(t))

      const CONCURRENCY = 4
      for (let i = 0; i < typesToFetch.length; i += CONCURRENCY) {
        if (controller.signal.aborted) break
        const batch = typesToFetch.slice(i, i + CONCURRENCY)
        const fetches = batch.map(async (type) => {
          try {
            const resp = await api.searchResources(type, namespace || undefined, controller.signal)
            const extractItems = (obj: any): any[] => {
              if (Array.isArray(obj)) return obj
              if (obj && typeof obj === 'object') {
                const inner = obj.data && typeof obj.data === 'object' ? obj.data : obj
                if (Array.isArray(inner.items)) {
                  const listKind = (inner.kind as string) ?? ''
                  const itemKind = listKind.endsWith('List') ? listKind.slice(0, -4) : listKind
                  const apiVersion = (inner.apiVersion as string) ?? ''
                  return inner.items.map((it: any) => ({
                    ...it,
                    kind: it.kind || itemKind,
                    apiVersion: it.apiVersion || apiVersion,
                  }))
                }
              }
              return []
            }
            failedTypesRef.current.delete(type)
            items.push(...extractItems(resp))
          } catch (err: any) {
            if (err?.name === 'CanceledError' || err?.name === 'AbortError') return
            failedTypesRef.current.add(type)
            errors.push({ type, error: err?.message ?? 'Failed' })
          }
        })
        await Promise.all(fetches)
      }

      const grouped = new Map<string, number>()
      const filtered = items.filter(item => {
        const kind = (item.kind as string) ?? 'Unknown'
        const count = grouped.get(kind) ?? 0
        if (count >= maxItemsPerResource) return false
        grouped.set(kind, count + 1)
        return true
      })

      return { items: filtered, errors }
    },
    enabled: resourceTypes.length > 0,
    staleTime: 30_000,
    refetchInterval: refetchIntervalMs > 0 ? refetchIntervalMs : false,
  })

  const items = useMemo(() => fetchResult?.items ?? [], [fetchResult])
  const fetchErrors = fetchResult?.errors ?? []

  // Strip managedFields for autocomplete perf
  const jsonItems = useMemo(() => {
    return items.map(it => {
      const copy = { ...it }
      const meta = copy.metadata as Record<string, unknown> | undefined
      if (meta) {
        const { managedFields: _, ...rest } = meta
        copy.metadata = rest
      }
      return copy
    })
  }, [items])

  // Search state
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchTimeMs, setSearchTimeMs] = useState<number | null>(null)
  const [isSearching, setIsSearching] = useState(false)

  useEffect(() => {
    if (!deferredQuery.trim() || items.length === 0) {
      setSearchResults(prev => prev.length === 0 ? prev : [])
      setSearchTimeMs(prev => prev === null ? prev : null)
      setIsSearching(false)
      return
    }

    const cancelToken = { current: false }
    setIsSearching(true)

    searchWithExpression(items, deferredQuery, cancelToken).then(({ results, timeMs }) => {
      if (!cancelToken.current) {
        setSearchResults(results.map(toSearchResult))
        setSearchTimeMs(timeMs)
        setIsSearching(false)
      }
    })

    return () => { cancelToken.current = true }
  }, [deferredQuery, items])

  const deferredResults = useDeferredValue(searchResults)

  const handleExampleSelect = useCallback((types: string[], query: string) => {
    if (types.length > 0) {
      setSelectedResources(new Set(types))
    }
    setRawQuery(query)
  }, [])

  const showResults = deferredQuery.trim().length > 0 && deferredResults.length > 0 && !isSearching
  const showExamples = !deferredQuery.trim()

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4 p-6 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Search className="w-7 h-7 text-sky-400" />
            {t('advancedSearch.title', 'Advanced Search')}
            <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 font-medium">
              Beta
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {t('advancedSearch.subtitle', 'Search across Kubernetes resources using JavaScript expressions')}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-slate-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          {t('advancedSearch.refresh', 'Refresh')}
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <ResourceTypePicker
          selected={selectedResources}
          onChange={setSelectedResources}
          extraResources={extraResources}
        />

        <SearchSettings
          maxItemsPerResource={maxItemsPerResource}
          setMaxItemsPerResource={setMaxItemsPerResource}
          refetchIntervalMs={refetchIntervalMs}
          setRefetchIntervalMs={setRefetchIntervalMs}
        />

        {/* Namespace filter */}
        <select
          value={namespace}
          onChange={e => setNamespace(e.target.value)}
          className="px-3 py-2 rounded-lg bg-slate-700 border border-slate-600 text-sm text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">{t('advancedSearch.allNamespaces', 'All Namespaces')}</option>
          {namespaces?.map(ns => (
            <option key={ns.name} value={ns.name}>{ns.name}</option>
          ))}
        </select>

        {/* Item count + errors */}
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5 text-slate-500">
            {(isLoadingResources || isFetching) ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
            ) : (
              <Database className="w-3.5 h-3.5" />
            )}
            {isLoadingResources ? (
              t('advancedSearch.loading', 'Loading resources...')
            ) : isFetching ? (
              t('advancedSearch.refreshing', 'Refreshing... ({{count}} loaded)', { count: items.length })
            ) : (
              t('advancedSearch.loaded', '{{count}} items loaded', { count: items.length })
            )}
          </span>
          {fetchErrors.length > 0 && (
            <span
              className="flex items-center gap-1 text-amber-400 cursor-help"
              title={fetchErrors.map(e => `${e.type}: ${e.error}`).join(', ')}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              {t('advancedSearch.someErrors', '{{count}} failed', { count: fetchErrors.length })}
            </span>
          )}
        </div>
      </div>

      {/* Query Editor (with Monaco autocomplete) */}
      <SearchQueryEditor
        value={rawQuery}
        onChange={setRawQuery}
        onClear={() => setRawQuery('')}
        isSearching={isSearching}
        resultCount={deferredQuery.trim() ? deferredResults.length : null}
        totalCount={items.length}
        searchTimeMs={searchTimeMs}
        items={jsonItems}
      />

      {/* Loading overlay */}
      {isLoadingResources && (
        <div className="flex flex-col items-center justify-center gap-3 py-16">
          <Loader2 className="w-8 h-8 animate-spin text-sky-400" />
          <p className="text-sm text-slate-400">
            {t('advancedSearch.loadingData', 'Loading {{count}} resource types...', { count: resourceTypes.length })}
          </p>
          <p className="text-xs text-slate-600">
            {t('advancedSearch.loadingHint', 'This may take a moment for large clusters')}
          </p>
        </div>
      )}

      {/* Results or Examples */}
      {!isLoadingResources && showResults && (
        <SearchResultTable results={deferredResults} />
      )}

      {!isLoadingResources && showExamples && (
        <SearchExamples onSelect={handleExampleSelect} />
      )}

      {/* No results message */}
      {!isLoadingResources && deferredQuery.trim() && !isSearching && deferredResults.length === 0 && items.length > 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
          <AlertCircle className="w-8 h-8" />
          <p className="text-sm">{t('advancedSearch.noResults', 'No resources match your query')}</p>
          <p className="text-xs text-slate-600">
            {t('advancedSearch.noResultsHint', 'Check your expression syntax or try a different query')}
          </p>
        </div>
      )}

      {/* No resources selected */}
      {selectedResources.size === 0 && (
        <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
          <Search className="w-8 h-8" />
          <p className="text-sm">{t('advancedSearch.noResources', 'Select resource types to search')}</p>
        </div>
      )}
    </div>
  )
}
