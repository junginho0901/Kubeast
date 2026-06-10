// Module-level ref for the currently selected cluster id, so non-React code
// (the axios interceptor, the WebSocket multiplexer) can read it without a
// hook. ClusterContext keeps this in sync with the React state / URL query.
//
// Kept in its own tiny module (no React import) so service files can read the
// cluster without pulling the context's react-router dependency into their
// bundle graph.

let _id = ''

export function getCurrentClusterID(): string {
  return _id
}

export function setCurrentClusterRef(id: string): void {
  _id = id
}

// X-Cluster-Name header for the AI chat streams (custom fetch, not the axios
// client) so ai-service scopes tool calls to the active cluster (step 14).
export function clusterHeaders(): Record<string, string> {
  return _id ? { 'X-Cluster-Name': _id } : {}
}
