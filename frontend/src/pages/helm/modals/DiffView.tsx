import { useMemo } from 'react'
import { html as diffToHtml, parse as diffParse } from 'diff2html'
import 'diff2html/bundles/css/diff2html.min.css'

// DiffView renders a unified-diff string as diff2html side-by-side
// coloured diff. Falls back to <pre> when the parser returns nothing
// (e.g. empty input) so the UI still shows *something* rather than a
// blank box.
export default function DiffView({ diff }: { diff: string }) {
  const html = useMemo(() => {
    if (!diff || !diff.trim()) return ''
    try {
      const files = diffParse(diff)
      return diffToHtml(files, {
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
      <pre className="max-h-[50vh] overflow-auto rounded bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-200 whitespace-pre">
        {diff || '—'}
      </pre>
    )
  }

  return (
    <div
      className="helm-diff2html max-h-[60vh] overflow-auto rounded border border-slate-700 bg-slate-950"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
