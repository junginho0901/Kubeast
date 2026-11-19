import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ExternalHttpLink } from './ExternalHttpLink'
import { safeHttpHref } from '@/utils/safeHttpHref'
import reportModal from '@/components/InvestigationReportModal.tsx?raw'
import alertWindow from '@/pages/alerts/AlertInbox.tsx?raw'

const draw = (url: string) => renderToStaticMarkup(createElement(ExternalHttpLink, { url, children: 'Alert sender' }))

// what an Alertmanager message may hold, and the href the browser would open for it
const LINKS: Array<[string, string]> = [
  ['http://prometheus:9090/graph?g0.expr=up%3D%3D0&g0.tab=1', 'http://prometheus:9090/graph?g0.expr=up%3D%3D0&g0.tab=1'],
  ['https://alertmanager.example.com', 'https://alertmanager.example.com/'],
  ['HTTPS://Alertmanager.Example.com/#/alerts', 'https://alertmanager.example.com/#/alerts'],
  ['http://[::1]:9093/', 'http://[::1]:9093/'],
  ['  https://am.example.com/ ', 'https://am.example.com/'],
  ['https://am.exa\tmple.com/', 'https://am.example.com/'],
]

const WORDS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  ' \u0001javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'ftp://files.example.com/',
  '/graph?g0.expr=up',
  '//other.example.com/graph',
  'graph?g0.expr=up',
  'https://',
  '   ',
  '',
]

describe('an address the console did not write', () => {
  it.each(LINKS)('%j is a link to %s, opened in a new tab', (url, href) => {
    expect(safeHttpHref(url)).toBe(href)
    const html = draw(url)
    expect(html).toContain(`<a href="${href.replace(/&/g, '&amp;')}" target="_blank" rel="noreferrer noopener"`)
    expect(html).toContain('Alert sender')
    expect(html).not.toContain('address-as-text')
  })

  it.each(WORDS)('%j is words, not a link', (url) => {
    expect(safeHttpHref(url)).toBeNull()
    const html = draw(url)
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href=')
    expect(html).toMatch(/^<span [^>]*data-testid="address-as-text">Alert sender<\/span>$/)
  })

  it('keeps the address it did not link on hover, as its words', () => {
    expect(draw('data:text/html,<script>alert(1)</script>')).toContain('title="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"')
  })

  it('takes no value as no link', () => {
    expect(safeHttpHref(undefined)).toBeNull()
    expect(safeHttpHref(null)).toBeNull()
  })
})

// The webhook keeps generatorURL and externalURL as Alertmanager sent them.
describe("the windows that show an alert's Alertmanager addresses", () => {
  it.each([
    ['the investigation report', reportModal],
    ['the alert window', alertWindow],
  ])('%s draws both through ExternalHttpLink', (_name, source) => {
    expect(source).not.toMatch(/href=\{data\./)
    expect(source.match(/<ExternalHttpLink url=\{data\.(generator_url|alertmanager_url)\}>/g)).toEqual([
      '<ExternalHttpLink url={data.generator_url}>',
      '<ExternalHttpLink url={data.alertmanager_url}>',
    ])
  })
})
