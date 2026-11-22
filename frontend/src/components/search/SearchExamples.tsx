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
            className="group flex flex-col items-start gap-1 px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 hover:border-primary-500/30 hover:bg-slate-800 transition-all text-left"
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-primary-500/10 text-primary-400 font-semibold">
                {ex.types.length === 0 ? t('advancedSearch.examplesAll', 'All') : ex.label}
              </span>
              <span className="text-xs text-slate-500">{t(`advancedSearch.examples.${ex.key}`, ex.description)}</span>
            </div>
            <code className="text-xs text-slate-300 font-mono group-hover:text-primary-300 transition-colors">
              {ex.query}
            </code>
          </button>
        ))}
      </div>
    </div>
  )
}
