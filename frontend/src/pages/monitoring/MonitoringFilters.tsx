import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, CheckCircle } from 'lucide-react'

interface NamespaceOption {
  name: string
}

interface NamespaceFilterProps {
  namespaces: NamespaceOption[] | undefined
  value: string
  onChange: (next: string) => void
}

// NamespaceFilter — the namespace dropdown shared by the Pods tab.
// Encapsulates the click-outside / open / value logic so the parent
// only sees value/onChange.
export function NamespaceFilter({ namespaces, value, onChange }: NamespaceFilterProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const label =
    value === ''
      ? t('monitoring.namespace.placeholder')
      : value === 'all'
        ? t('monitoring.namespace.all')
        : value

  return (
    <div className="mb-6 overflow-visible">
      <label className="block text-sm font-medium text-slate-400 mb-2">
        {t('monitoring.namespace.label')}
      </label>
      <div className="relative w-full md:w-64" ref={containerRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors flex items-center gap-2 justify-between"
        >
          <span className="text-sm font-medium">{label}</span>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 transition-transform ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-100 max-h-[200px] overflow-y-auto">
            <button
              onClick={() => {
                onChange('')
                setIsOpen(false)
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
            >
              {value === '' && (
                <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
              )}
              <span className={value === '' ? 'font-medium' : ''}>
                {t('monitoring.namespace.placeholder')}
              </span>
            </button>
            <button
              onClick={() => {
                onChange('all')
                setIsOpen(false)
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2"
            >
              {value === 'all' && (
                <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
              )}
              <span className={value === 'all' ? 'font-medium' : ''}>
                {t('monitoring.namespace.all')}
              </span>
            </button>
            {Array.isArray(namespaces) &&
              namespaces.map((ns) => (
                <button
                  key={ns.name}
                  onClick={() => {
                    onChange(ns.name)
                    setIsOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                >
                  {value === ns.name && (
                    <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                  )}
                  <span className={value === ns.name ? 'font-medium' : ''}>
                    {ns.name}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
