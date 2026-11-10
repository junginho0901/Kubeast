// Usage against the limit: yellow from 60%, red from 80% (the node bars' thresholds); no limit, no colour.
export const usageTone = (pct: number | null) => (pct === null ? 'text-ink' : pct >= 80 ? 'text-red-400' : pct >= 60 ? 'text-yellow-400' : 'text-ink')
