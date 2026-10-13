import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { aiEnabled } from '@/utils/features'

// Wraps the AI pages (chat, AI models, AI usage): with chart ai.enabled off the
// route stays reachable by URL but shows this notice instead of a page whose
// every call would end in the gateway's 503.
export default function AIGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { data: features } = useClusterFeatures()
  if (aiEnabled(features)) return <>{children}</>
  return (
    <div className="m-6 rounded-lg border border-slate-700 bg-slate-800/50 p-6 text-slate-300 flex items-start gap-3" data-testid="ai-disabled-notice">
      <Bot className="w-5 h-5 mt-0.5 text-slate-400 shrink-0" />
      <div>
        <div className="font-semibold text-white">{t('ai.disabled.title', { defaultValue: 'AI is off in this installation' })}</div>
        <p className="mt-1 text-sm">{t('ai.disabled.body', { defaultValue: 'The chart was installed with ai.enabled: false, so there is no AI service, no AI tools and no MCP server here.' })}</p>
      </div>
    </div>
  )
}
