import type { ConnectionResult } from '@/services/api/clusters'
import { failureText } from '@/utils/failureText'
import { formatTime, utcTitle } from '@/utils/time'

// What a Test pressed on this page found, and when. It stays under the cluster's health until that cluster's next
// Test (the Health column above it is the server's, which the Test wrote).
export type TestOutcome = { healthy: boolean; detail: string; at: string }

// The server's answer (the version it read, or why it could not connect), or why the request itself failed.
export function testOutcome(res: ConnectionResult | null, err: unknown, at: string): TestOutcome {
  if (!res) return { healthy: false, detail: failureText(err), at }
  return { healthy: res.healthy, detail: (res.healthy ? res.server_version : res.message) ?? '', at }
}

// When the cluster's health was last checked (the server's background check or a Test), as the Health column writes
// it: the viewer's time, the UTC value on hover. Nothing for a cluster never checked.
export function healthChecked(at: string | undefined): { text: string; title: string } | null {
  return at ? { text: formatTime(at), title: utcTitle(at) ?? at } : null
}
