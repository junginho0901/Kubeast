import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AIMarkdown } from '@/components/AIMarkdown'
import reportModal from '@/components/InvestigationReportModal.tsx?raw'
import optimizationModal from '@/pages/dashboard/modals/OptimizationModal.tsx?raw'

// An investigation report and the optimization answer are text a model wrote: a link in them opens beside the console,
// and raw HTML stays words, since neither has the chat's allow list.

const render = (text: string) => renderToStaticMarkup(createElement(AIMarkdown, null, text))

describe('AIMarkdown', () => {
  it('opens a link in a new tab without telling the page where it came from', () => {
    const html = render('[runbook](https://example.test/runbook)')
    expect(html).toContain('href="https://example.test/runbook"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('a bare address opens in a new tab too', () => {
    expect(render('see https://example.test/page')).toContain('target="_blank"')
  })

  it('does not link to a script', () => {
    expect(render('[x](javascript:alert)')).not.toContain('javascript:')
  })

  it('shows raw HTML as nothing that acts', () => {
    const html = render('<script>globalThis.x = 1</script>\n\n<a href="https://example.test/raw">raw</a>\n\ntext')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="https://example.test/raw"')
    expect(html).toContain('text')
  })

  it('keeps tables and ranges as the shared Markdown rules read them', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |\n\n10~14%')
    expect(html).toContain('<table>')
    expect(html).toContain('10~14%')
  })
})

describe('the windows that show a model\'s text', () => {
  it.each([
    ['the investigation report', reportModal],
    ['the optimization answer', optimizationModal],
  ])('%s goes through AIMarkdown', (_name, source) => {
    expect(source).not.toMatch(/<ReactMarkdown\b/)
    expect(source).toMatch(/<AIMarkdown\b/)
  })
})
