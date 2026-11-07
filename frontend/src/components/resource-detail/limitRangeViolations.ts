// The server lists one row per container and field; "Violating Pods" counts the pods.
export function violatingPodCount(violations: Array<{ pod: string; namespace?: string }>): number {
  return new Set(violations.map((v) => `${v.namespace ?? ''}/${v.pod}`)).size
}
