// Endpoints 페이지의 검색 + 네임스페이스 드롭다운 필터
//
// frontend/src/pages/network/Endpoints.tsx 의 Search input + Namespace
// dropdown + click-outside useEffect 추출. dropdown 의 ref/effect 는 이
// 컴포넌트 자체 보유.

import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react'
import { CheckCircle, ChevronDown, Search } from 'lucide-react'

interface NamespaceLite {
  name: string
}

interface Props {
  searchQuery: string
  setSearchQuery: Dispatch<SetStateAction<string>>
  selectedNamespace: string
  setSelectedNamespace: Dispatch<SetStateAction<string>>
  namespaces: NamespaceLite[] | undefined
  searchPlaceholder: string
  allNamespacesLabel: string
}

export function EndpointFilters({
  searchQuery,
  setSearchQuery,
  selectedNamespace,
  setSelectedNamespace,
  namespaces,
  searchPlaceholder,
  allNamespacesLabel,
}: Props) {
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (namespaceDropdownRef.current && !namespaceDropdownRef.current.contains(event.target as Node)) {
        setIsNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isNamespaceDropdownOpen])

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
      <div className="xl:col-span-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>

      <div className="relative" ref={namespaceDropdownRef}>
        <button
          type="button"
          onClick={() => setIsNamespaceDropdownOpen((v) => !v)}
          className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
        >
          <span className="text-sm font-medium">
            {selectedNamespace === 'all' ? allNamespacesLabel : selectedNamespace}
          </span>
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`} />
        </button>
        {isNamespaceDropdownOpen && (
          <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                setSelectedNamespace('all')
                setIsNamespaceDropdownOpen(false)
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
            >
              {selectedNamespace === 'all' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
              <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{allNamespacesLabel}</span>
            </button>
            {(namespaces || []).map((ns) => (
              <button
                key={ns.name}
                type="button"
                onClick={() => {
                  setSelectedNamespace(ns.name)
                  setIsNamespaceDropdownOpen(false)
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
              >
                {selectedNamespace === ns.name && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>{ns.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
