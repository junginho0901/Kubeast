import type { TFunction } from 'i18next'

// A refusal the chat server writes for the screen (the token budget) comes with a catalog key and values next to
// its English text; other stream errors are shown as they came.
export function chatErrorText(t: TFunction, error: string, key?: string | null, args?: Record<string, unknown> | null): string {
  if (!key) return error
  const values = Object.fromEntries(
    Object.entries(args ?? {}).map(([k, v]) => [k, typeof v === 'number' ? v.toLocaleString() : v]),
  )
  return t(`aiChat.error.${key}`, { defaultValue: error, ...values })
}
