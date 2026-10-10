// Drawer labels are written in English in the detail components. ko.json's
// `detail` block — registered as its own i18next namespace with no key or
// namespace separators, so a label may hold "." or ":" — maps the descriptive
// ones (Name, Created, Status, …); Kubernetes kinds and field names (UID,
// Selector, Finalizers, …) have no plain entry and fall through to the English label.
//
// A label may carry {{placeholders}} ("Used By Pods ({{n}})") filled from
// `values`, so a count does not make every title a different key. Avoid the
// option names i18next reserves (count, context, ns, lng).
export const DETAIL_NS = 'detail'

export type LabelValues = Record<string, string | number>

export type TranslateFn = (
  key: string,
  options: { defaultValue: string; ns: string; keySeparator: false; nsSeparator: false; [value: string]: unknown },
) => string

export function translateDetailLabel(t: TranslateFn, label: string, values?: LabelValues): string {
  if (!label) return label
  return t(label, { ...values, ns: DETAIL_NS, keySeparator: false, nsSeparator: false, defaultValue: label })
}

// Section titles use the Korean Kubernetes terms (kubernetes.io/ko: 셀렉터, 파이널라이저, …) while a
// field label with the same English word stays English, so a title's entry is keyed "section:<title>"
// and falls back to the plain label.
export function translateDetailSection(t: TranslateFn, title: string, values?: LabelValues): string {
  if (!title) return title
  const plain = translateDetailLabel(t, title, values)
  return t(`section:${title}`, { ...values, ns: DETAIL_NS, keySeparator: false, nsSeparator: false, defaultValue: plain })
}
