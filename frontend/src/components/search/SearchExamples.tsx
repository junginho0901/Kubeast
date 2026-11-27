import { useTranslation } from 'react-i18next'
import { Lightbulb } from 'lucide-react'
import { EXAMPLE_QUERIES } from './exampleQueries'

interface Props {
  onSelect: (types: string[], query: string) => void
}

export default function SearchExamples({ onSelect }: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <div className="flex items-center gap-2 text-slate-400">
        <Lightbulb className="w-5 h-5" />
        <span className="text-sm font-medium">
          {t('advancedSearch.examplesTitle', 'Example Queries')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 justify-center max-w-2xl">
        {EXAMPLE_QUERIES.map((ex, i) => (
          <button
            key={i}
            onClick={() => onSelect(ex.types, ex.query)}
            className="group flex max-w-full flex-col items-start gap-1 px-4 py-3 rounded-lg bg-slate-800 border border-control hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400 transition-colors text-left"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-900 text-slate-300 font-semibold">
                {ex.types.length === 0 ? t('advancedSearch.examplesAll', 'All') : ex.label}
              </span>
              <span className="text-xs text-slate-500">{t(`advancedSearch.examples.${ex.key}`, ex.description)}</span>
            </div>
            <code className="text-xs text-slate-300 font-mono [overflow-wrap:anywhere] group-hover:text-ink transition-colors">
              {ex.query}
            </code>
          </button>
        ))}
      </div>
    </div>
  )
}
