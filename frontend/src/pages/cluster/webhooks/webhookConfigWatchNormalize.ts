// Validating and Mutating webhook configuration watch event → the list's row, and applying it to the list.

import type { WebhookConfigInfo } from '@/services/api'
import { applyRowEvent } from '@/services/applyRowEvent'

export function normalizeWatchWebhookConfigObject(obj: any): WebhookConfigInfo {
  if (typeof obj?.name === 'string' && typeof obj?.webhooks_count === 'number') {
    return obj as WebhookConfigInfo
  }
  const metadata = obj?.metadata ?? {}
  return {
    name: metadata?.name ?? obj?.name ?? '',
    webhooks_count: obj?.webhooks?.length ?? obj?.webhooks_count ?? 0,
    labels: metadata?.labels ?? obj?.labels ?? {},
    created_at: metadata?.creationTimestamp ?? obj?.created_at ?? '',
  }
}

export function applyWebhookConfigWatchEvent(
  prev: WebhookConfigInfo[] | undefined,
  event: { type?: string; object?: any },
): WebhookConfigInfo[] {
  return applyRowEvent(prev, event, normalizeWatchWebhookConfigObject)
}
