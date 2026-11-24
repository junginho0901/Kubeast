// A value as a PromQL double-quoted string: the backslash first, then the quote, so Prometheus reads back the value as it was.
export const promString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
