// Resource graph 페이지 상단 헤더 (namespace 멀티선택 / 검색 / Group By / Status / 필터 패널)
//
// frontend/src/pages/ResourceGraph.tsx 의 헤더 JSX (namespace 드롭다운 + 검색 +
// Group By + Issues + Filter toggle + Filter panel) 추출. dropdown click-outside
// useEffect 도 자체 보유.

import { Dispatch, SetStateAction, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, Filter, Search, X } from 'lucide-react'
import type { ResourceGraphEdgeType } from '@/services/api'
import {
  ALL_EDGE_TYPES,
  ALL_KINDS,
  edgeStyles,
  kindIcon,
  SOURCE_GROUPS,
  type GroupBy,
} from './constants'

interface NamespaceLite {
  name: string
}

interface Props {
  // counts
  nodeCount: number
  edgeCount: number
  // namespaces
  namespaces: NamespaceLite[] | undefined
  selectedNamespaces: Set<string>
  setSelectedNamespaces: Dispatch<SetStateAction<Set<string>>>
  isNsDropdownOpen: boolean
  setIsNsDropdownOpen: Dispatch<SetStateAction<boolean>>
  // search
  searchQuery: string
  setSearchQuery: Dispatch<SetStateAction<string>>
  // group by
  groupBy: GroupBy
  setGroupBy: Dispatch<SetStateAction<GroupBy>>
  // status filter
  statusFilter: 'all' | 'issues'
  setStatusFilter: Dispatch<SetStateAction<'all' | 'issues'>>
  // filter panel
  showFilters: boolean
  setShowFilters: Dispatch<SetStateAction<boolean>>
  kindFilters: Set<string>
  setKindFilters: Dispatch<SetStateAction<Set<string>>>
  edgeTypeFilters: Set<string>
  setEdgeTypeFilters: Dispatch<SetStateAction<Set<string>>>
}

export function ResourceGraphHeader({
  nodeCount,
  edgeCount,
  namespaces,
  selectedNamespaces,
  setSelectedNamespaces,
  isNsDropdownOpen,
  setIsNsDropdownOpen,
  searchQuery,
  setSearchQuery,
  groupBy,
  setGroupBy,
  statusFilter,
  setStatusFilter,
  showFilters,
  setShowFilters,
  kindFilters,
  setKindFilters,
  edgeTypeFilters,
  setEdgeTypeFilters,
}: Props) {
  const { t } = useTranslation()
  const nsDropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!isNsDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (nsDropdownRef.current && !nsDropdownRef.current.contains(event.target as globalThis.Node)) {
        setIsNsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isNsDropdownOpen, setIsNsDropdownOpen])

  const toggleNs = (ns: string) => {
    setSelectedNamespaces(prev => {
      const next = new Set(prev)
      if (next.has(ns)) next.delete(ns)
      else next.add(ns)
      return next
    })
  }

  const toggleSourceGroup = (groupId: string) => {
    const group = SOURCE_GROUPS.find(g => g.id === groupId)
    if (!group) return
    setKindFilters(prev => {
      const next = new Set(prev)
      const allEnabled = group.kinds.every(k => next.has(k))
      if (allEnabled) {
        group.kinds.forEach(k => next.delete(k))
      } else {
        group.kinds.forEach(k => next.add(k))
      }
      return next
    })
  }

  const toggleEdgeType = (type: ResourceGraphEdgeType | string) => {
    setEdgeTypeFilters(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <div className="flex-shrink-0 px-6 py-4 border-b border-slate-700">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold text-white">
          {t('resourceGraph.title', 'Resource Graph')}
        </h1>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>{nodeCount} nodes</span>
          <span>·</span>
          <span>{edgeCount} edges</span>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {/* Namespace selector (multi-select) */}
        <div className="relative" ref={nsDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNsDropdownOpen(!isNsDropdownOpen)}
            className="h-9 px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 flex items-center gap-2 min-w-[180px] justify-between"
          >
            <span className="truncate">
              {selectedNamespaces.size === 0
                ? 'Select Namespace...'
                : [...selectedNamespaces].join(', ')}
            </span>
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNsDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {isNsDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[280px] overflow-y-auto">
              {selectedNamespaces.size > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedNamespaces(new Set())}
                  className="w-full px-4 py-2 text-left text-xs text-slate-400 hover:bg-slate-600 transition-colors border-b border-slate-600"
                >
                  Clear selection
                </button>
              )}
              {(namespaces || []).map(ns => (
                <button
                  key={ns.name}
                  type="button"
                  onClick={() => toggleNs(ns.name)}
                  className="w-full px-4 py-2 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2"
                >
                  {selectedNamespaces.has(ns.name) && <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />}
                  <span className={selectedNamespaces.has(ns.name) ? 'font-medium' : ''}>{ns.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder={t('resourceGraph.search', 'Search resources...')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="h-9 w-full pl-8 pr-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
              <X className="w-3.5 h-3.5 text-slate-400 hover:text-white" />
            </button>
          )}
        </div>

        {/* Group By */}
        <div className="flex items-center gap-1 bg-slate-700 rounded-lg p-0.5">
          {([['none', 'None'], ['namespace', 'NS'], ['node', 'Node'], ['instance', 'Instance']] as const).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => setGroupBy(val)}
              className={`px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                groupBy === val ? 'bg-primary-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Status filter */}
        <button
          type="button"
          onClick={() => setStatusFilter(prev => prev === 'all' ? 'issues' : 'all')}
          className={`h-9 px-3 rounded-lg text-sm flex items-center gap-1.5 transition-colors ${
            statusFilter === 'issues' ? 'bg-red-600/30 text-red-300 border border-red-500/50' : 'bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600'
          }`}
        >
          ⚠ {t('resourceGraph.issuesOnly', 'Issues')}
        </button>

        {/* Filter toggle */}
        <button
          type="button"
          onClick={() => setShowFilters(!showFilters)}
          className={`h-9 px-3 rounded-lg text-sm flex items-center gap-1.5 transition-colors ${
            showFilters ? 'bg-primary-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          <Filter className="w-4 h-4" />
          {t('resourceGraph.filter', 'Filter')}
        </button>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="mt-3 p-3 bg-slate-800 border border-slate-700 rounded-lg grid grid-cols-2 gap-4">
          {/* Source groups */}
          <div>
            <div className="text-xs font-medium text-slate-400 mb-2">{t('resourceGraph.sources', 'Sources')}</div>
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_GROUPS.map(group => {
                const allEnabled = group.kinds.every(k => kindFilters.has(k))
                const someEnabled = group.kinds.some(k => kindFilters.has(k))
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => toggleSourceGroup(group.id)}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${
                      allEnabled
                        ? 'bg-primary-600/30 text-primary-300 border border-primary-500/50'
                        : someEnabled
                        ? 'bg-primary-600/10 text-primary-400 border border-primary-500/30'
                        : 'bg-slate-700 text-slate-500 border border-slate-600'
                    }`}
                  >
                    {group.label}
                  </button>
                )
              })}
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {ALL_KINDS.map(kind => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    setKindFilters(prev => {
                      const next = new Set(prev)
                      if (next.has(kind)) next.delete(kind)
                      else next.add(kind)
                      return next
                    })
                  }}
                  className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                    kindFilters.has(kind)
                      ? 'bg-slate-600 text-white'
                      : 'bg-slate-800 text-slate-600'
                  }`}
                >
                  {kindIcon[kind] || '📄'} {kind}
                </button>
              ))}
            </div>
          </div>

          {/* Edge types */}
          <div>
            <div className="text-xs font-medium text-slate-400 mb-2">{t('resourceGraph.legend', 'Edge Types')}</div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_EDGE_TYPES.map(type => {
                const style = edgeStyles[type]
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleEdgeType(type)}
                    className={`px-2 py-0.5 rounded text-xs flex items-center gap-1.5 transition-colors ${
                      edgeTypeFilters.has(type)
                        ? 'bg-slate-700 border border-slate-500'
                        : 'bg-slate-800 text-slate-500 border border-slate-700'
                    }`}
                  >
                    <span
                      className="inline-block w-4 h-0.5"
                      style={{
                        backgroundColor: style.stroke,
                        borderTop: style.strokeDasharray ? `2px dashed ${style.stroke}` : undefined,
                        height: style.strokeDasharray ? 0 : 2,
                      }}
                    />
                    <span style={{ color: edgeTypeFilters.has(type) ? style.stroke : undefined }}>
                      {style.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
