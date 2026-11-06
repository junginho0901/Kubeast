// A node's Allocated Resources as the drawer and the floating chat show them: kubectl describe node's rows from the
// server (k8s-service node_allocated.go), why they are missing, and the namespaces a limited grant counts.
export interface AllocatedRow {
  resource: string
  requests: string
  limits: string
}

export interface NodeAllocatedView {
  rows: AllocatedRow[]
  error?: string
  scope?: string[]
}

export function nodeAllocatedView(describe: unknown): NodeAllocatedView {
  const d = (describe ?? {}) as { allocated_resources?: AllocatedRow[]; allocated_error?: string; allocated_scope?: string[] }
  return {
    rows: d.allocated_resources ?? [],
    ...(d.allocated_error ? { error: d.allocated_error } : {}),
    ...(d.allocated_scope?.length ? { scope: d.allocated_scope } : {}),
  }
}

// When the node's Ready condition last changed: all a node's status says of it, not how long it has been up.
export function readyChangedAt(conditions: Array<{ type?: string; last_transition_time?: string }> | undefined): string | undefined {
  return conditions?.find((c) => c.type === 'Ready')?.last_transition_time
}
