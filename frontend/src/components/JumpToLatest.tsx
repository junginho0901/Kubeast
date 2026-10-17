import { ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// The "jump to latest" control of a chat list that stopped following because the reader scrolled up.
export default function JumpToLatest({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  const label = t('aiChat.jumpToLatest', { defaultValue: 'Jump to latest' })
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid="jump-to-latest"
      className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 flex h-8 w-8 items-center justify-center rounded-full border border-slate-600 bg-slate-800/90 text-slate-200 shadow-lg transition-opacity duration-200 hover:bg-slate-700 motion-reduce:transition-none starting:opacity-0"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  )
}
