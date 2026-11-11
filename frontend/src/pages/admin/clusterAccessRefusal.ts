import { failureText } from '@/utils/failureText'

// What the server said when it refused a cluster access read or change (its reason in `detail`), else the request's
// own error; null without an error.
export function refusalText(err: unknown): string | null {
  return err ? failureText(err) : null
}
