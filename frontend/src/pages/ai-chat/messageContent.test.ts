import { describe, expect, it } from 'vitest'
import { truncateToolResultsInContent } from './messageContent'

// A long tool result shows cut on screen, in a code block of any length: three backticks, or more when its result holds some.

const block = (fence: string, body: string, language = '') =>
  `<details>\n<summary><strong>📊 Results</strong></summary>\n\n${fence}${language}\n${body}\n${fence}\n\n</details>\n\nThe answer.`

describe('cutting a long tool result on screen', () => {
  it('cuts a long result in a plain block and leaves a short one', () => {
    const long = truncateToolResultsInContent(block('```', 'x'.repeat(3000), 'json'))
    expect(long).toBe(block('```', `${'x'.repeat(2000)}\n... (truncated) ...`, 'json'))
    expect(truncateToolResultsInContent(block('```', 'short'))).toBe(block('```', 'short'))
  })

  it('cuts a long result whose block is longer than three backticks, backtick lines in it or not', () => {
    const body = `first\n\`\`\`\n${'x'.repeat(3000)}`
    const cut = truncateToolResultsInContent(block('````', body))
    expect(cut).toBe(block('````', `${body.slice(0, 2000)}\n... (truncated) ...`))
    expect(cut).toContain('The answer.')
  })

  it('leaves a short result in a longer block whole', () => {
    const body = 'first\n```\nsecond'
    expect(truncateToolResultsInContent(block('````', body))).toBe(block('````', body))
  })

  it('cuts each block by its own length', () => {
    const one = block('````', `a\n\`\`\`\n${'x'.repeat(3000)}`)
    const two = block('```', 'y'.repeat(3000))
    const cut = truncateToolResultsInContent(`${one}\n\n${two}`)
    expect(cut.split('... (truncated) ...').length - 1).toBe(2)
    expect(cut).toContain(`${'y'.repeat(2000)}\n... (truncated) ...\n\`\`\``)
  })
})
