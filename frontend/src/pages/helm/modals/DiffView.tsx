import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { html as diffToHtml, parse as diffParse } from 'diff2html'
import 'diff2html/bundles/css/diff2html.min.css'
import { revisionFiles } from './diffFiles'

// DiffView renders a unified-diff string as diff2html side-by-side
// coloured diff. Falls back to <pre> when the parser returns nothing
// (e.g. empty input) so the UI still shows *something* rather than a
// blank box.
export default function DiffView({ diff }: { diff: string }) {
  const { t } = useTranslation()
  const html = useMemo(() => {
    if (!diff || !diff.trim()) return ''
    try {
      return diffToHtml(revisionFiles(diffParse(diff)), {
        drawFileList: false,
        matching: 'lines',
        outputFormat: 'side-by-side',
        colorScheme: 'dark' as any,
      })
    } catch {
      return ''
    }
  }, [diff])

  if (!html) {
    return (
      <pre className="max-h-[50vh] overflow-auto rounded-lg bg-slate-900 border border-hairline px-3 py-2 text-xs text-slate-200 whitespace-pre">
        {diff || t('common.none', 'None')}
      </pre>
    )
  }

  return (
    <div
      className="helm-diff2html max-h-[60vh] overflow-auto rounded-lg border border-hairline bg-slate-900"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
