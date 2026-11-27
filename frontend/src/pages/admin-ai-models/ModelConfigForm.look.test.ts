import { describe, expect, it } from 'vitest'
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
})
