// What the floating chat's layer gets from a Secret's describe answer: never a value. data_values is the values, and
// kubectl's last-applied annotation repeats them, so annotations go by name, as the drawer's own layer sends them.
export function secretDescribeForAI(describe: unknown): Record<string, unknown> | undefined {
  if (!describe) return undefined
  const { data_values: _values, annotations, ...rest } = describe as Record<string, unknown>
  return annotations ? { ...rest, annotations: Object.keys(annotations as Record<string, unknown>) } : rest
}
