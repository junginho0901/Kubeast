import { describe, expect, it } from 'vitest'
import { YAML_EDITOR_MAX, YAML_EDITOR_MIN, yamlEditorHeight } from './modalStyles'

// Re-QA #53/#58: the create window's editor follows the text instead of a
// fixed 460px that left a short example floating in empty space.
describe('yamlEditorHeight', () => {
  it('fits the text between the floor and the cap', () => {
    expect(yamlEditorHeight('a: 1')).toBe(YAML_EDITOR_MIN)
    expect(yamlEditorHeight(Array(20).fill('a: 1').join('\n'))).toBe(20 * 18 + 24)
    expect(yamlEditorHeight(Array(200).fill('a: 1').join('\n'))).toBe(YAML_EDITOR_MAX)
  })
})
