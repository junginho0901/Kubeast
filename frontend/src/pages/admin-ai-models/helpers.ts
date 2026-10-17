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
