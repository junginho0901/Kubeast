import { MessageSquare } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { failureText } from '@/utils/failureText'
import { aiConfigRetry, aiConfigRetryDelay } from './utils'

// AIChat 상단 고정 헤더 — title + AI model 뱃지 + subtitle.
// aiConfig 조회는 자체에서 (5분 캐시) — header 외 다른 곳에서 모델명 필요 없음.
// The read refused (no model set up yet, the AI service down) says why under the subtitle instead of the badge, in two
// lines at most so the header stays as high as the conversation list's beside it, the whole reason on hover.

export function ChatHeader() {
  const { t } = useTranslation()
  const { data: aiConfig, error } = useQuery({
    queryKey: ['ai-config'],
    queryFn: api.getAIConfig,
    staleTime: 5 * 60 * 1000,
    retry: aiConfigRetry,
    retryDelay: aiConfigRetryDelay,
  })
  const reason = error ? t('aiChat.modelReadFailed', { defaultValue: 'Could not read the AI model: {{reason}}', reason: failureText(error) }) : null

  return (
    <div className="px-6 py-4 border-b border-hairline bg-slate-800 min-h-[100px] shrink-0 flex items-center">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-ink flex items-center gap-3">
            <MessageSquare className="w-6 h-6 text-slate-300" />
            {t('aiChat.title')}
          </h1>
          {aiConfig && !error && (
            <span className="max-w-full break-all px-2.5 py-1 text-xs font-medium bg-slate-700/50 text-slate-300 rounded-full border border-hairline">
              {(aiConfig as { model: string }).model}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {t('aiChat.subtitle')}
        </p>
        {reason && (
          <p role="alert" data-testid="ai-config-failed" title={reason} className="mt-1 text-sm text-red-400 break-words line-clamp-2">
            {reason}
          </p>
        )}
      </div>
    </div>
  )
}
