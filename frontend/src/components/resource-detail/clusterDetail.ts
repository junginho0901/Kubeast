// What the cluster-scoped drawers work out from an object, by the rules Kubernetes itself uses.

/** A webhook rule as describe sends it (formatWebhookRules). */
export interface WebhookRule {
  api_groups?: string[] | null
  api_versions?: string[] | null
  operations?: string[] | null
  resources?: string[] | null
  scope?: string
}

/**
 * Every (API group, resource) pair and every operation a webhook configuration's rules name — the API server sends a
 * request to a webhook when one of its rules names the request's group, resource and operation — as `group/resource`
 * (the core group `""`), each list sorted.
 */
export function webhookAffected(webhooks: { rules?: WebhookRule[] | null }[]): { resources: string[]; operations: string[] } {
  const resources = new Set<string>()
  const operations = new Set<string>()
  for (const wh of webhooks) {
    for (const r of wh.rules ?? []) {
      const groups = r.api_groups?.length ? r.api_groups : ['']
      for (const g of groups) for (const res of r.resources ?? []) resources.add(`${g || '""'}/${res}`)
      for (const op of r.operations ?? []) operations.add(op)
    }
  }
  return { resources: [...resources].sort(), operations: [...operations].sort() }
}

export type LeaseHolderState = 'Active' | 'Expired' | 'None'

/**
 * A lease is held while its holder renews it in time: Active when it names a holder and renewTime +
 * leaseDurationSeconds is not before now, Expired when the holder let it run out or the lease has no renew time or
 * duration to tell (the API server's own lease controllers, isLeaseExpired in apiserverleasegc and leaderelection),
 * None without a holder. kubectl get lease prints the HOLDER only.
 */
export function leaseHolderState(
  lease: { holder_identity?: string | null; renew_time?: string | null; lease_duration_seconds?: number | null },
  nowMs: number,
): LeaseHolderState {
  if (!lease.holder_identity) return 'None'
  const renewed = lease.renew_time ? Date.parse(lease.renew_time) : NaN
  if (Number.isNaN(renewed) || lease.lease_duration_seconds == null) return 'Expired'
  return renewed + lease.lease_duration_seconds * 1000 < nowMs ? 'Expired' : 'Active'
}
