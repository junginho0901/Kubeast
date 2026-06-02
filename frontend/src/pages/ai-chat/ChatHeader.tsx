import { Sparkles } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'

// AIChat 상단 고정 헤더 — title + AI model 뱃지 + subtitle.
// aiConfig 조회는 자체에서 (5분 캐시) — header 외 다른 곳에서 모델명 필요 없음.

export function ChatHeader() {
  const { t } = useTranslation()
  const { data: aiConfig } = useQuery({
    queryKey: ['ai-config'],
    queryFn: api.getAIConfig,
    staleTime: 5 * 60 * 1000,
  })

  return (
    <div className="px-6 border-b border-slate-700 bg-slate-800 h-[100px] flex items-center">
      <div className="flex-1">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-white flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-yellow-400" />
            {t('aiChat.title')}
          </h1>
          {aiConfig && (
            <span className="px-2.5 py-1 text-xs font-medium bg-primary-500/20 text-primary-400 rounded-full border border-primary-500/30">
              {(aiConfig as { model: string }).model}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-400">
          {t('aiChat.subtitle')}
        </p>
      </div>
    </div>
  )
}
