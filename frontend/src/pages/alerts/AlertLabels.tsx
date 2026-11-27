import { useTranslation } from 'react-i18next'

// An alert's labels and annotations in its window, as Alertmanager sent them: an empty value reads -, no annotations None.
export function AlertLabels({ labels, annotations }: { labels: Record<string, string>; annotations: Record<string, string> }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-slate-400">{tr('alertInbox.section.labels', 'Labels and annotations')}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <dl className="border-t border-hairline py-2 text-xs" data-testid="alert-labels">
          {Object.entries(labels).map(([k, v]) => (
            <div key={k} className="flex gap-2 py-0.5"><dt className="w-[110px] shrink-0 break-all text-slate-500">{k}</dt><dd className="min-w-0 break-all font-mono text-slate-200">{v || '-'}</dd></div>
          ))}
        </dl>
        <dl className="border-t border-hairline py-2 text-xs">
          {Object.entries(annotations).map(([k, v]) => (
            <div key={k} className="flex gap-2 py-0.5"><dt className="w-[110px] shrink-0 break-all text-slate-500">{k}</dt><dd className="min-w-0 break-words text-slate-200">{v || '-'}</dd></div>
          ))}
          {Object.keys(annotations).length === 0 && <div className="text-slate-500">{tr('common.none', 'None')}</div>}
        </dl>
      </div>
    </section>
  )
}
