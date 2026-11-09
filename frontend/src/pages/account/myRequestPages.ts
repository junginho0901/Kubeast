// Settings → Cluster access → My requests: the server cuts a page of the user's requests, newest first, and counts
// them all, so every request is reached.

export const MY_REQUESTS_PER_PAGE = 10

export function myRequestsQuery(page: number): { limit: number; offset: number } {
  return { limit: MY_REQUESTS_PER_PAGE, offset: (Math.max(1, page) - 1) * MY_REQUESTS_PER_PAGE }
}

// Under ['access-requests', 'mine'], so a new request or a cancel reads the pages again; the Settings page waits
// for the first page (accountReady) with the same key, one request for both.
export function myRequestsKey(query: { limit: number; offset: number }): unknown[] {
  return ['access-requests', 'mine', 'page', query]
}
