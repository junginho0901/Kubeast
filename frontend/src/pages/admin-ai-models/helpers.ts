import { PROVIDER_CATALOG, type ProviderDef } from '@/constants/modelCatalog'
import { DropdownOption } from '@/components/CustomDropdown'

export const providerOptions: DropdownOption[] = PROVIDER_CATALOG.map((p) => ({
  value: p.id,
  label: p.label,
  icon: p.icon,
  testId: `provider-option-${p.id}`,
}))

export function modelOptions(provDef: ProviderDef, fetched?: { name: string; label?: string }[]): DropdownOption[] {
  if (!fetched?.length) {
    return provDef.models.map((m) => ({
      value: m.name,
      label: m.label ?? m.name,
      listHint: m.note,
      hint: !m.functionCalling ? 'no tools' : undefined,
      testId: `model-option-${m.name}`,
    }))
  }
  // The provider's list, with the built-in label and tool support where the built-in list knows the model
  return fetched.map((f) => {
    const known = provDef.models.find((m) => m.name === f.name)
    return {
      value: f.name,
      label: f.label ?? known?.label ?? f.name,
      listHint: f.label ? undefined : known?.note,
      hint: known && !known.functionCalling ? 'no tools' : undefined,
      testId: `model-option-${f.name}`,
    }
  })
}

// A model's own limits, kept in its options next to the generation options (ai-service app/services/ai/limits.py).
export const LIMIT_RANGES = { max_tokens: [1, 1_000_000], tool_result_chars: [1_000, 200_000] } as const
export type LimitKey = keyof typeof LIMIT_RANGES
export type LimitsError = LimitKey | 'in_json'

/** The limits as the form's two fields and the other options as the JSON field shows them. */
export function splitLimits(options: Record<string, unknown> | null | undefined) {
  const { max_tokens, tool_result_chars, ...rest } = options ?? {}
  return {
    maxTokens: max_tokens == null ? '' : String(max_tokens),
    toolResultChars: tool_result_chars == null ? '' : String(tool_result_chars),
    rest: Object.keys(rest).length ? rest : null,
  }
}

function limitValue(key: LimitKey, text: string): number | undefined | null {
  const v = text.replace(/[,_\s]/g, '')
  if (!v) return undefined
  const [lo, hi] = LIMIT_RANGES[key]
  return /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null
}

/** The options to save: the JSON field's object with the two limits, null when nothing is left. */
export function buildOptions(
  rest: Record<string, unknown> | null,
  maxTokens: string,
  toolResultChars: string,
): { options: Record<string, unknown> | null } | { error: LimitsError } {
  if (rest && Object.keys(LIMIT_RANGES).some((k) => k in rest)) return { error: 'in_json' }
  const options: Record<string, unknown> = { ...(rest ?? {}) }
  for (const [key, text] of [['max_tokens', maxTokens], ['tool_result_chars', toolResultChars]] as const) {
    const v = limitValue(key, text)
    if (v === null) return { error: key }
    if (v !== undefined) options[key] = v
  }
  return { options: Object.keys(options).length ? options : null }
}
