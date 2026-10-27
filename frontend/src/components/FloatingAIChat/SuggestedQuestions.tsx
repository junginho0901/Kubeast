import { useTranslation } from 'react-i18next'

interface SuggestedQuestionsProps {
  pageType: string
  onPick: (question: string) => void
}

// pageType (PageContextProvider) → i18n key 매핑
const PAGE_TYPE_TO_KEY: Record<string, string> = {
  dashboard: 'dashboard',
  'resource-list': 'resourceList',
  'resource-detail': 'resourceDetail',
  gpu: 'gpu',
  monitoring: 'monitoring',
  topology: 'topology',
  search: 'search',
  'helm-list': 'helmList',
}

// i18n 로딩 실패/누락 시 폴백 (한국어 기본 — 운영자 관점)
const FALLBACK: Record<string, string[]> = {
  default: [
    '이 화면의 핵심 정보 설명',
    '여기서 자주 발생하는 문제와 트러블슈팅',
    '주기적으로 확인해야 할 항목',
  ],
}

/**
 * 빈 대화 상태에서 사용자에게 페이지 타입에 맞춘 추천 질문을 제시.
 *
 * 질문은 i18n 의 `floatingChat.suggested.<key>` 배열에서 가져온다 (returnObjects).
 * 단순 "이 화면 뭐야?" 가 아니라 운영자가 즉시 가치를 얻을 수 있는
 * 진단/분석/우선순위 위주 질문으로 구성.
 */
export function SuggestedQuestions({ pageType, onPick }: SuggestedQuestionsProps) {
  const { t } = useTranslation()
  const key = PAGE_TYPE_TO_KEY[pageType] ?? 'default'

  const raw = t(`floatingChat.suggested.${key}`, {
    returnObjects: true,
    defaultValue: FALLBACK.default,
  })
  const questions: string[] = Array.isArray(raw) ? (raw as string[]) : FALLBACK.default

  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <span>{t('floatingChat.suggestedLabel', { defaultValue: 'Suggestions' })}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {questions.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onPick(q)}
            className="text-left rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-200 transition-colors hover:border-primary-500/60 hover:bg-primary-600/10 hover:text-primary-300"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}
