import type { ConnectionResult } from '@/services/api/clusters'
import { formatTime, utcTitle } from '@/utils/time'

// A Test result with the cluster list answer it was read with (dataUpdatedAt).
export type HeldTest = ConnectionResult & { listAt: number }

// The Test result stands in the Health column for the list answer read after
// it (the health the test wrote); a newer answer — another Test, an edit, a
// refetch — shows the server's health again.
export function shownTest(held: HeldTest | undefined, listUpdatedAt: number): ConnectionResult | null {
  return held && held.listAt === listUpdatedAt ? held : null
}

// When the cluster's health was last checked (the server's background check or a Test), as the Health column writes
// it: the viewer's time, the UTC value on hover. Nothing for a cluster never checked.
export function healthChecked(at: string | undefined): { text: string; title: string } | null {
  return at ? { text: formatTime(at), title: utcTitle(at) ?? at } : null
}
