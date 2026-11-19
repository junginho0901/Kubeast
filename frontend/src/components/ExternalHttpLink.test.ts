import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ExternalHttpLink } from './ExternalHttpLink'
import { safeHttpHref } from '@/utils/safeHttpHref'
import CASES from '@/utils/safeHttpHref.cases.json'
import reportModal from '@/components/InvestigationReportModal.tsx?raw'
import alertWindow from '@/pages/alerts/AlertInbox.tsx?raw'

const draw = (url: string) => renderToStaticMarkup(createElement(ExternalHttpLink, { url, children: 'Alert sender' }))

// what an Alertmanager message may hold, and the href the browser would open for it (the webhook's answers are
// tests/test_alert_webhook_addresses.py's)
const LINKS = CASES.cases.flatMap((c) => (c.href === null ? [] : [{ name: c.name, address: c.address, href: c.href }]))
const WORDS = CASES.cases.filter((c) => c.href === null)

describe('an address the console did not write', () => {
  it('has cases of both kinds', () => {
    expect([LINKS.length, WORDS.length]).toEqual([8, 19])
  })

  it.each(LINKS)('$name is a link to its address as the browser reads it, opened in a new tab', ({ address, href }) => {
    expect(safeHttpHref(address)).toBe(href)
    const html = draw(address)
    expect(html).toContain(`<a href="${href.replace(/&/g, '&amp;')}" target="_blank" rel="noreferrer noopener"`)
    expect(html).toContain('Alert sender')
    expect(html).not.toContain('address-as-text')
  })

  it.each(WORDS)('$name is words, not a link', ({ address }) => {
    expect(safeHttpHref(address)).toBeNull()
    const html = draw(address)
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

// Rows the webhook stored before it kept only http and https addresses hold what Alertmanager sent.
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
