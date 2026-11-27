import { useTranslation } from 'react-i18next'

import { URL_PROBLEM_TEXT, type UrlProblem } from '@/utils/urlField'

export function UrlFieldProblem({ problem, testId }: { problem: UrlProblem | null; testId: string }) {
  const { t } = useTranslation()
  if (!problem) return null
  const { key, defaultValue } = URL_PROBLEM_TEXT[problem]
  return (
    <p role="alert" data-testid={testId} className="mt-1 text-xs text-notice-text-failed">
      {t(key, { defaultValue })}
    </p>
  )
}
