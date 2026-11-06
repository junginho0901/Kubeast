import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

// The top of a chat list while the conversation has messages the screen does not hold (AI Chat, the floating chat):
// how many, and the button that reads the page before them.
export default function EarlierMessages({ hidden, loading, error, onLoad }: { hidden: number; loading: boolean; error?: string | null; onLoad: () => void }) {
  const { t } = useTranslation()
  if (hidden <= 0) return null
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 px-4 py-3 text-xs text-slate-400" data-testid="chat-earlier">
      <span data-testid="chat-earlier-count">{t('aiChat.earlier.hidden', { defaultValue: 'Earlier messages not shown: {{count}}', count: hidden })}</span>
      <button type="button" onClick={onLoad} disabled={loading} className="btn-row" data-testid="chat-earlier-load">
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {t('aiChat.earlier.load', { defaultValue: 'Load earlier messages' })}
      </button>
      {error && <span className="text-red-400" data-testid="chat-earlier-error">{t('aiChat.earlier.error', { defaultValue: 'Could not load the earlier messages: {{error}}', error })}</span>}
    </div>
  )
}
