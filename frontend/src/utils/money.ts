// Money for the Cost page and the optimization table: small cluster costs need
// more decimals than dollars-and-cents, large ones fewer, so the digits follow
// the size of the amount. An amount that is not a number shows as "-".
export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount == null || !Number.isFinite(amount)) return '-'
  const abs = Math.abs(amount)
  const digits = abs === 0 ? 0 : abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
  } catch {
    return `${amount.toFixed(digits)} ${currency}`
  }
}

// A share (0..1) as a whole percent; "-" when there is none.
export function formatPercent(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share)) return '-'
  return `${Math.round(share * 100)}%`
}
