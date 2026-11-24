// A value as a PromQL double-quoted string: the backslash first, then the quote, so Prometheus reads back the value as it was.
export const promString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// A value a PromQL regular expression (RE2) matches as itself: each metacharacter behind a backslash. The expression
// then goes through promString, which writes each backslash twice.
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
