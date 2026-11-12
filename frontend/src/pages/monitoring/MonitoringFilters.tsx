import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, CheckCircle, Search } from 'lucide-react'
import { useDismiss } from '@/hooks/useDismiss'

// The list search box of both tabs (the list pages' h-12 style); it narrows the rows by name. className places it: on
// its own line (the default) or in a row of controls.
export function MonitoringSearch({ value, onChange, placeholder, testId, className = 'mb-4' }: { value: string; onChange: (next: string) => void; placeholder: string; testId: string; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="h-12 w-full pl-10 pr-4 bg-slate-700 border border-slate-600 rounded-lg text-sm text-ink placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:border-transparent"
      />
    </div>
  )
}

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
// only sees value/onChange. It sits in the tab's row of controls at the search box's height and a fixed width; its
// label, no longer drawn above it, is the button's title and the start of its name, before the namespace shown.
export function NamespaceFilter({ namespaces, value, onChange }: NamespaceFilterProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useDismiss(isOpen, containerRef, setIsOpen)

  const label =
    value === ''
      ? t('monitoring.namespace.placeholder')
      : value === 'all'
        ? t('monitoring.namespace.all')
        : value

  return (
    <div className="relative w-full md:w-64 shrink-0" ref={containerRef}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          data-testid="monitoring-namespace"
          aria-label={`${t('monitoring.namespace.label')}: ${label}`}
          title={t('monitoring.namespace.label')}
          className="h-12 w-full px-4 bg-slate-700 hover:bg-slate-600 text-ink rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors flex items-center gap-2 justify-between"
        >
          <span className="text-sm font-medium truncate min-w-0">{label}</span>
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
              className="w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
            >
              {value === '' && (
                <CheckCircle className="w-4 h-4 text-primary-400 shrink-0" />
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
              className="w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-slate-600 transition-colors flex items-center gap-2"
            >
              {value === 'all' && (
                <CheckCircle className="w-4 h-4 text-primary-400 shrink-0" />
              )}
              <span className={value === 'all' ? 'font-medium' : ''}>
                {t('monitoring.namespace.all')}
              </span>
            </button>
            {Array.isArray(namespaces) &&
              namespaces.map((ns) => (
                <button
                  key={ns.name}
                  data-testid={`monitoring-namespace-opt-${ns.name}`}
                  onClick={() => {
                    onChange(ns.name)
                    setIsOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                >
                  {value === ns.name && (
                    <CheckCircle className="w-4 h-4 text-primary-400 shrink-0" />
                  )}
                  <span className={value === ns.name ? 'font-medium' : ''}>
                    {ns.name}
                  </span>
                </button>
              ))}
          </div>
        )}
    </div>
  )
}
