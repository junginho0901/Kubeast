import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import { REMARK_PLUGINS } from './markdown'

const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: REMARK_PLUGINS }, md))

describe('REMARK_PLUGINS', () => {
  it('leaves ranges written with one tilde as text', () => {
    const out = html('apiserver 824~864 MiB, grafana 289~303 MiB')
    expect(out).not.toContain('<del>')
    expect(out).toContain('824~864 MiB, grafana 289~303')
  })

  it('still strikes out between two tildes and keeps tables', () => {
    expect(html('~~old~~ new')).toContain('<del>old</del>')
    expect(html('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>')
  })
})
