import { useTranslation } from 'react-i18next'
import { translateDetailLabel } from './detailLabel'

// Labels in the detail components are English; ko.json `detail.*` maps the
// descriptive ones, Kubernetes kinds and field names fall through unchanged.
export function useDetailLabel(): (label: string) => string {
  const { t } = useTranslation()
  return (label) => translateDetailLabel(t, label)
}
