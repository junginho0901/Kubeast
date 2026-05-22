// ResourceQuotas 페이지 상단 필터 (검색 + namespace dropdown).
//
// ResourceQuotas.tsx 본체에서 분리. search input + namespace dropdown +
// click-outside useEffect 를 자체 보유.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Search } from 'lucide-react'

interface ResourceQuotaFiltersProps {
  searchQuery: string
  onSearchChange: (value: string) => void
  selectedNamespace: string
  onNamespaceChange: (value: string) => void
  namespaces: any[] | undefined
}

export function ResourceQuotaFilters({
  searchQuery,
  onSearchChange,
  selectedNamespace,
  onNamespaceChange,
  namespaces,
}: ResourceQuotaFiltersProps) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
      <div className="xl:col-span-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={tr('resourceQuotas.searchPlaceholder', 'Search resource quotas by name or namespace...')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>
      <div ref={dropdownRef} className="relative">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          className="h-12 w-full flex items-center justify-between px-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white"
        >
          <span className="truncate">
            {selectedNamespace === 'all'
              ? tr('resourceQuotas.allNamespaces', 'All Namespaces')
              : selectedNamespace}
          </span>
          <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
        </button>
        {isOpen && (
          <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg bg-slate-800 border border-slate-600 shadow-xl">
            <button
              type="button"
              className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-700 ${
                selectedNamespace === 'all' ? 'text-primary-400 font-medium' : 'text-white'
              }`}
              onClick={() => { onNamespaceChange('all'); setIsOpen(false) }}
            >
              {tr('resourceQuotas.allNamespaces', 'All Namespaces')}
            </button>
            {(namespaces || []).map((ns: any) => (
              <button
                key={ns.name}
                type="button"
                className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-700 ${
                  selectedNamespace === ns.name ? 'text-primary-400 font-medium' : 'text-white'
                }`}
                onClick={() => { onNamespaceChange(ns.name); setIsOpen(false) }}
              >
                {ns.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
