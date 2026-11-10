// The dashboard Pods slot's figure and bar: "35 / 330" and its percent, or the count alone when the nodes'
// allocatable pods are not answered.
export function podsShown(count: number | null, capacity: number | null | undefined): { text: string; percent: number | null } | null {
  if (count === null) return null
  const n = Math.round(count)
  if (!capacity || capacity <= 0) return { text: String(n), percent: null }
  return { text: `${n} / ${Math.round(capacity)}`, percent: (n / capacity) * 100 }
}
