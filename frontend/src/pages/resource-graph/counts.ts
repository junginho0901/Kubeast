// The graph's totals for the header and the floating chat: every box the server sent and every line between two of
// them — a line to an object the graph has no box for (an owner of a kind it does not list, such as a Rollout) is
// never drawn, so it is not counted.
export function graphTotals(graph?: { nodes?: { id: string }[]; edges?: { source: string; target: string }[] } | null) {
  const ids = new Set((graph?.nodes ?? []).map((n) => n.id))
  return { nodes: ids.size, edges: (graph?.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target)).length }
}
