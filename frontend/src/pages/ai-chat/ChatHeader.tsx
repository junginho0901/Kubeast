import { MessageSquare } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { failureText } from '@/utils/failureText'

// AIChat 상단 고정 헤더 — title + AI model 뱃지 + subtitle.
// aiConfig 조회는 자체에서 (5분 캐시) — header 외 다른 곳에서 모델명 필요 없음.
// The read refused (no model set up yet, the AI service down) says why under the subtitle instead of the badge.

export function ChatHeader() {
  const { t } = useTranslation()
  const { data: aiConfig, error } = useQuery({
    queryKey: ['ai-config'],
    queryFn: api.getAIConfig,
    staleTime: 5 * 60 * 1000,
  })

  return (
    <div className="px-6 border-b border-slate-700 bg-slate-800 min-h-[100px] flex items-center">
      <div className="flex-1">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-ink flex items-center gap-3">
            <MessageSquare className="w-6 h-6 text-slate-300" />
            {t('aiChat.title')}
          </h1>
          {aiConfig && !error && (
            <span className="px-2.5 py-1 text-xs font-medium bg-primary-500/20 text-primary-400 rounded-full border border-primary-500/30">
              {(aiConfig as { model: string }).model}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {t('aiChat.subtitle')}
        </p>
        {error && (
          <p role="alert" data-testid="ai-config-failed" className="mt-1 text-sm text-red-400 break-words">
            {t('aiChat.modelReadFailed', { defaultValue: 'Could not read the AI model: {{reason}}', reason: failureText(error) })}
          </p>
        )}
      </div>
    </div>
  )
}
