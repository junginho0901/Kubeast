import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '../i18n/locales/en.json'
import ko from '../i18n/locales/ko.json'
import type { InvestigationResult, InvestigationToolCall } from '../services/api/investigations'
import { InvestigationResultView } from './InvestigationResultView'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const TOOL_CALLS: InvestigationToolCall[] = [
  { tool: 'timeline', args: { view: 'changes' }, step: 0, result_chars: 120 },
  { tool: 'k8s_get_pod_logs', args: { name: 'web-1', previous: true }, step: 1, result_chars: 800 },
  { tool: 'traces_search', args: {}, step: 2, error: 'not offered' },
]

const RESULT: InvestigationResult = {
  version: 1,
  status: 'ok',
  no_fault: false,
  causes: [{ resource: 'Deployment/apps/web', kind: 'rollout', started_at: null, evidence: [{ call: 1, tool: 'timeline' }] }],
  path: ['Deployment/apps/web', 'Pod/apps/web-1'],
  ruled_out: ['Node/kind-worker'],
  hypotheses: [
    { id: 'h1', statement: 'The node <b>ran</b> out of memory', resource: 'Node/kind-worker', state: 'ruled_out', for: [], against: [{ call: 2, tool: 'k8s_get_pod_logs' }], closed: true },
    { id: 'h2', statement: 'Image web:1.5 crashes on **start**', resource: 'Deployment/apps/web', state: 'cause', for: [{ call: 1, tool: 'timeline' }, { call: 2, tool: 'k8s_get_pod_logs' }], against: [], closed: true },
    { id: 'h3', statement: 'Traces show the slow span', resource: '', state: 'blocked', for: [{ call: 3, tool: 'traces_search', failed: true }], against: [], blocked: 'traces_search is not offered', closed: true },
    { id: 'h4', statement: 'The database is down', resource: 'StatefulSet/apps/db', state: 'open', for: [], against: [], closed: false, problems: [{ reason: 'open' }] },
  ],
  asked_again: true,
}

const render = async (result: InvestigationResult, lng = 'en') => {
  await i18n.changeLanguage(lng)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(InvestigationResultView, { result, toolCalls: TOOL_CALLS })))
}

const rows = (html: string) => [...html.matchAll(/<tr class="[^"]*" data-state="(\w+)">(.*?)<\/tr>/g)].map((m) => ({ state: m[1], html: m[2] }))

describe("the report window's result and hypotheses", () => {
  it('draws the hypotheses causes first with their state, the calls for and against them and why one is open', async () => {
    const html = await render(RESULT)
    const table = rows(html)
    expect(table.map((r) => r.state)).toEqual(['cause', 'open', 'blocked', 'ruled_out'])
    expect(table[0].html).toContain('badge badge-error')
    expect(table[0].html).toContain('#1 timeline')
    expect(table[0].html).toContain('#2 k8s_get_pod_logs')
    expect(table[1].html).toContain('Not closed: no state of the four')
    expect(table[2].html).toContain('Blocked: traces_search is not offered')
    expect(table[2].html).toContain('border-red-800/60')  // a refused call is marked
    expect(table[3].html).toContain('badge badge-neutral')
    expect(html).toContain('data-list-bounded=')
    expect(html).toContain('Hypotheses (4)')
    expect(html).toContain('Deployment/apps/web → Pod/apps/web-1')
    expect(html).toContain(en.investigations.result.askedAgain)
  })

  it('shows a call’s arguments on hover', async () => {
    expect(await render(RESULT)).toContain('title="{&quot;name&quot;:&quot;web-1&quot;,&quot;previous&quot;:true}"')
  })

  it('draws the model’s text as plain text, neither HTML nor Markdown', async () => {
    const html = await render(RESULT)
    expect(html).toContain('The node &lt;b&gt;ran&lt;/b&gt; out of memory')
    expect(html).not.toContain('<b>ran</b>')
    expect(html).toContain('crashes on **start**')
  })

  it('says so when the report ended without a block it could read, and draws no table', async () => {
    const html = await render({ ...RESULT, status: 'missing', causes: [], path: [], ruled_out: [], hypotheses: [], asked_again: true })
    expect(html).toContain(en.investigations.result.missing)
    expect(html).not.toContain('data-testid="investigation-hypotheses"')
  })

  it('says a report that finds no fault, with None for no hypotheses', async () => {
    const html = await render({ ...RESULT, no_fault: true, causes: [], path: [], ruled_out: [], hypotheses: [], asked_again: false })
    expect(html).toContain(en.investigations.result.noFault)
    expect(html).toContain('Hypotheses (0)')
    expect(html).toContain(`>${en.common.none}<`)
  })

  it('marks a cause the calls do not show as not verified', async () => {
    const html = await render({ ...RESULT, causes: [{ ...RESULT.causes[0], verified: false, reason: 'name_missing' }, { ...RESULT.causes[0], resource: 'Pod/apps/web-1', verified: true }] })
    const marks = [...html.matchAll(/data-testid="investigation-cause-unverified">([^<]*)</g)].map((m) => m[1])
    expect(marks).toEqual([`Not verified: ${en.investigations.result.unverified.name_missing}`])
    expect(await render({ ...RESULT, causes: [{ ...RESULT.causes[0], verified: false, reason: 'after_alert' }] }, 'ko'))
      .toContain(`확인 안 됨: ${ko.investigations.result.unverified.after_alert}`)
  })

  it('says under each list the server cut how many of how many it shows', async () => {
    const causes = Array.from({ length: 10 }, (_v, i) => ({ ...RESULT.causes[0], resource: `Deployment/shop/cart${i}` }))
    const cut: InvestigationResult = {
      ...RESULT,
      causes: [{ ...causes[0], cut: { evidence: { given: 25, kept: 20 } } }, ...causes.slice(1)],
      cut: { causes: { given: 11, kept: 10 }, path: { given: 14, kept: 12 }, ruled_out: { given: 21, kept: 20 } },
    }
    const html = await render(cut)
    expect([...html.matchAll(/data-testid="investigation-result-cut">([^<]*)</g)].map((m) => m[1])).toEqual([
      'Showing the first 10 of 11: the server did not keep the rest.',
      'Showing the first 12 of 14: the server did not keep the rest.',
      'Showing the first 20 of 21: the server did not keep the rest.',
    ])
    expect(html).toContain('data-testid="investigation-cause-calls-cut">Showing the first 20 of 25: the server did not keep the rest.<')
    expect(await render(cut, 'ko')).toContain('>11개 중 앞의 10개를 보여 줍니다. 나머지는 서버가 저장하지 않았습니다.<')
    const fits = await render(RESULT)
    expect(fits).not.toContain('data-testid="investigation-result-cut"')
    expect(fits).not.toContain('data-testid="investigation-cause-calls-cut"')
  })

  it('says under the hypotheses and under a side of one how many of how many it shows', async () => {
    const html = await render({
      ...RESULT,
      hypotheses: [{ ...RESULT.hypotheses[1], cut: { for: { given: 21, kept: 20 }, against: { given: 25, kept: 20 } } }, ...RESULT.hypotheses.slice(2)],
      cut: { hypotheses: { given: 13, kept: 12 } },
    })
    expect([...html.matchAll(/data-testid="investigation-result-cut">([^<]*)</g)].map((m) => m[1])).toEqual([
      'Showing the first 12 of 13: the server did not keep the rest.',
    ])
    expect([...html.matchAll(/data-testid="investigation-hypothesis-calls-cut">([^<]*)</g)].map((m) => m[1])).toEqual([
      'Showing the first 20 of 21: the server did not keep the rest.',
      'Showing the first 20 of 25: the server did not keep the rest.',
    ])
    expect(await render(RESULT)).not.toContain('investigation-hypothesis-calls-cut')
  })

  it('shows no hypotheses when the ledger did not read the block', async () => {
    const html = await render({ ...RESULT, hypotheses: [], checks: { evidence: true, ledger: false } })
    expect(html).not.toContain('Hypotheses (')
    expect(html).not.toContain('data-testid="investigation-hypotheses"')
    expect(html).toContain(`>${en.investigations.result.titleCauses}<`)
    expect(html).toContain('data-testid="investigation-result-causes"')
    expect(await render({ ...RESULT, checks: { evidence: false, ledger: true } })).toContain('Hypotheses (4)')
  })

  it('says the answer stopped inside its block', async () => {
    const html = await render({ ...RESULT, status: 'cut', causes: [], path: [], ruled_out: [], hypotheses: [], asked_again: true })
    expect(html).toContain(en.investigations.result.cut)
    expect(html).not.toContain(en.investigations.result.missing)
  })

  it('reads in Korean from the catalog', async () => {
    const html = await render(RESULT, 'ko')
    expect(html).toContain(ko.investigations.result.title)
    expect(html).toContain(`>${ko.investigations.result.state.cause}<`)
    expect(html).toContain('닫히지 않음: 네 상태 중 어느 것도 아님')
  })
})
