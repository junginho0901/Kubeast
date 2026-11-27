import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import source from './ModelConfigForm.tsx?raw'

// The edit form under a model card keeps its small buttons and takes the console's shared colours.
const buttonOf = (onClick: string) => {
  const start = source.indexOf(`onClick={${onClick}}`, source.indexOf('{!inModal && <div className="ml-auto flex gap-2">'))
  return source.slice(start, source.indexOf('>', source.indexOf('className=', start)))
}

describe('the edit form under a model card', () => {
  it('hovers Update a shade darker, as every main button does, at its small size', () => {
    const update = buttonOf('handleSubmit')
    expect(update).toContain('bg-primary-600')
    expect(update).toContain('hover:bg-primary-700')
    expect(update).toContain('px-3 py-1.5 text-xs')
    expect(update).toContain('disabled={isSaving || !formName || !formModel || !!unavailableReason || !!baseUrlProblem}')
  })

  it('draws Cancel as the shared secondary button, no taller than Update', () => {
    expect(buttonOf('resetForm')).toContain('className="btn btn-secondary px-3 py-1.5 text-xs"')
  })

  it('ends the two model list notes with a full stop in both languages and in its defaults', () => {
    for (const cat of [en, ko]) {
      expect(cat.admin.aiModels.modelsBuiltIn).toMatch(/\.$/)
      expect(cat.admin.aiModels.modelsNoList).toMatch(/\.$/)
    }
    expect(source).toContain(`tr('admin.aiModels.modelsBuiltIn', '${en.admin.aiModels.modelsBuiltIn.replace("'", "\\'")}')`)
    expect(source).toContain(`tr('admin.aiModels.modelsNoList', '${en.admin.aiModels.modelsNoList}')`)
  })

  it("keeps its title's icon in the neutral icon tone", () => {
    expect(source).toContain('<Pencil className="h-3.5 w-3.5 text-slate-400" />')
    expect(source).toContain('<Plus className="h-3.5 w-3.5 text-slate-400" />')
  })
})
