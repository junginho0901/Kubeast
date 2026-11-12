export const NOT_COUNTED = '-'

// A list not read (loading, refused, failed) counts nothing: the cards say "-", never a 0 they did not count.
export function countsOf<T extends Record<string, number>>(list: unknown, counts: T): { [K in keyof T]: number | string } {
  if (Array.isArray(list)) return counts
  return Object.fromEntries(Object.keys(counts).map((k) => [k, NOT_COUNTED])) as { [K in keyof T]: string }
}
