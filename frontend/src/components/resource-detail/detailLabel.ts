// Drawer labels are written in English in the detail components. The `detail`
// block of ko.json maps the descriptive ones (Name, Created, Status, …);
// Kubernetes kinds and field names (UID, Selector, Finalizers, …) have no entry
// and fall through to the English label.
//
// i18next splits keys on "." — labels that carry one (tls.crt) are literal
// identifiers and never looked up.
export function detailLabelKey(label: string): string | null {
  if (!label || label.includes('.') || label.includes(':')) return null
  return `detail.${label}`
}

export type TranslateFn = (key: string, options: { defaultValue: string }) => string

export function translateDetailLabel(t: TranslateFn, label: string): string {
  const key = detailLabelKey(label)
  return key ? t(key, { defaultValue: label }) : label
}
