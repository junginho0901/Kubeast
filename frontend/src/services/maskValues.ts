// The values behind a chat answer's numbered placeholders (<EMAIL_1>, <PHONE_1>, <RRN_1>, <CARD_1>), for the person who
// asked, whose own identity read them: ai-service sends them once with the saved answer (`mask_values`), and the answer is
// drawn with them in the placeholders' place (chatMarkdown's revealPlaceholders). The answer's text, Copy and every save
// keep the placeholders. They live in this tab's memory only: a reload, signing out or someone else signing in on the tab
// shows the placeholders again (onSessionChange).

import { onSessionChange } from './auth'

export type MaskValues = Readonly<Record<string, string>>

const PLACEHOLDERS = /<(?:EMAIL|PHONE|RRN|CARD)_[0-9]{1,6}>/g
const ONE_PLACEHOLDER = /^<(?:EMAIL|PHONE|RRN|CARD)_[0-9]{1,6}>$/
// the longest shape the server numbers is an e-mail address; anything longer is not one of its values
const VALUE_MAX = 320
// the answers of a long session in one tab: past this many the oldest are forgotten
const KEPT_ANSWERS = 200

// The pairs of a mask_values event, each a placeholder of the numbered kinds and a value; null when none is.
export function maskValuesFrom(raw: unknown): MaskValues | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [placeholder, value] of Object.entries(raw)) {
    if (ONE_PLACEHOLDER.test(placeholder) && typeof value === 'string' && value.length > 0 && value.length <= VALUE_MAX) {
      out[placeholder] = value
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

// The text with each placeholder that has a value replaced by it; one without a value stays as it is.
export function revealText(text: string, values: MaskValues | null | undefined): string {
  if (!values || !text.includes('<')) return text
  return text.replace(PLACEHOLDERS, (placeholder) => (Object.hasOwn(values, placeholder) ? values[placeholder] : placeholder))
}

// A saved answer's values by its message id, so the answer keeps them once the saved messages take its bubble's place.
const byMessage = new Map<number, MaskValues>()

export function rememberMaskValues(messageId: number, values: MaskValues) {
  byMessage.delete(messageId)
  byMessage.set(messageId, values)
  for (const oldest of byMessage.keys()) {
    if (byMessage.size <= KEPT_ANSWERS) break
    byMessage.delete(oldest)
  }
}

export function maskValuesOf(messageId: number | null | undefined): MaskValues | undefined {
  return messageId == null ? undefined : byMessage.get(messageId)
}

export function forgetMaskValues() {
  byMessage.clear()
}

onSessionChange(forgetMaskValues)
