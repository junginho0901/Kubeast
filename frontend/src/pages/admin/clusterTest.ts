import type { ConnectionResult } from '@/services/api/clusters'

// A Test result with the cluster list answer it was read with (dataUpdatedAt).
export type HeldTest = ConnectionResult & { listAt: number }

// The Test result stands in the Health column for the list answer read after
// it (the health the test wrote); a newer answer — another Test, an edit, a
// refetch — shows the server's health again.
export function shownTest(held: HeldTest | undefined, listUpdatedAt: number): ConnectionResult | null {
  return held && held.listAt === listUpdatedAt ? held : null
}
