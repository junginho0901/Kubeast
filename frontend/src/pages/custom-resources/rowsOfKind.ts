import type { CustomResourceInstanceInfo, CustomResourceInstanceList } from '@/services/api'

// The order the list of every kind answers in (the server's sortInstances): newest first, then CRD, namespace and name.
function byListOrder(a: CustomResourceInstanceInfo, b: CustomResourceInstanceInfo): number {
  if (a.created_at !== b.created_at) return (a.created_at ?? '') > (b.created_at ?? '') ? -1 : 1
  for (const field of ['crd_name', 'namespace', 'name'] as const) {
    if (a[field] !== b[field]) return (a[field] ?? '') < (b[field] ?? '') ? -1 : 1
  }
  return 0
}

// The rows of one CRD, as its own list answers them now, in the list of every kind: that list reads every CRD, so a kind
// that changes is not read through it. The fields beside the object's (its CRD, its scope) come from the rows that were
// there, since they are about the kind.
export function withRowsOfKind(list: CustomResourceInstanceList | undefined, crdName: string, rows: any[]): CustomResourceInstanceList | undefined {
  if (!list || !Array.isArray(list.items)) return list
  const known = list.items.find((item) => item.crd_name === crdName)
  if (!known) return list
  const others = list.items.filter((item) => item.crd_name !== crdName)
  const ofKind = rows.map((row): CustomResourceInstanceInfo => ({
    ...known,
    name: row.name,
    namespace: row.namespace,
    created_at: row.created_at,
    labels: row.labels,
  }))
  return { ...list, items: [...others, ...ofKind].sort(byListOrder) }
}
