import { PROVIDER_CATALOG, type ProviderDef } from '@/constants/modelCatalog'
import { DropdownOption } from '@/components/CustomDropdown'

export const providerOptions: DropdownOption[] = PROVIDER_CATALOG.map((p) => ({
  value: p.id,
  label: p.label,
  icon: p.icon,
}))

export function modelOptions(provDef: ProviderDef): DropdownOption[] {
  return provDef.models.map((m) => ({
    value: m.name,
    label: m.label ?? m.name,
    hint: !m.functionCalling ? 'no tools' : undefined,
  }))
}
