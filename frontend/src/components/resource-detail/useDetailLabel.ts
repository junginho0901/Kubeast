import { useTranslation } from 'react-i18next'
import { translateDetailLabel, translateDetailSection, type LabelValues, type TranslateFn } from './detailLabel'

// Labels in the detail components are English; ko.json `detail.*` maps the
// descriptive ones, Kubernetes kinds and field names fall through unchanged.
export function useDetailLabel(): (label: string, values?: LabelValues) => string {
  const { t } = useTranslation()
  return (label, values) => translateDetailLabel(t as unknown as TranslateFn, label, values)
}

// Section titles: "section:<title>" entries first (see translateDetailSection).
export function useDetailSection(): (title: string, values?: LabelValues) => string {
  const { t } = useTranslation()
  return (title, values) => translateDetailSection(t as unknown as TranslateFn, title, values)
}
