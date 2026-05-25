import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, Search } from 'lucide-react'

interface Props {
  searchQuery: string
  onSearchChange: (q: string) => void
  namespace: string
  onNamespaceChange: (ns: string) => void
  namespaces: string[]
}

export default function ReleaseFilters({
  searchQuery,
  onSearchChange,
  namespace,
  onNamespaceChange,
  namespaces,
}: Props) {
  const { t } = useTranslation()
  const [nsOpen, setNsOpen] = useState(false)
  const nsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!nsOpen) return
    const onClick = (e: MouseEvent) => {
      if (nsRef.current && !nsRef.current.contains(e.target as Node)) setNsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [nsOpen])

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 shrink-0">
      <div className="xl:col-span-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder={t('helmReleases.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </div>
      </div>
      <div className="relative" ref={nsRef}>
        <button
          type="button"
          onClick={() => setNsOpen(!nsOpen)}
          className="h-12 w-full px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
        >
          <span className="text-sm font-medium truncate">
            {namespace === '' ? t('helmReleases.allNamespaces') : namespace}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 transition-transform ${nsOpen ? 'rotate-180' : ''}`}
          />
        </button>
        {nsOpen && (
          <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[260px] overflow-y-auto">
            <button
              type="button"
              onClick={() => {
                onNamespaceChange('')
                setNsOpen(false)
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
            >
              {namespace === '' && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
              <span className={namespace === '' ? 'font-medium' : ''}>
                {t('helmReleases.allNamespaces')}
              </span>
            </button>
            {namespaces.map((ns) => (
              <button
                key={ns}
                type="button"
                onClick={() => {
                  onNamespaceChange(ns)
                  setNsOpen(false)
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
              >
                {namespace === ns && <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />}
                <span className={namespace === ns ? 'font-medium' : ''}>{ns}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
