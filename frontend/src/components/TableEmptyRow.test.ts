import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '../i18n/locales/en.json'
import { TableEmptyRow } from './TableEmptyRow'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})
const render = (props: Parameters<typeof TableEmptyRow>[0]) => renderToStaticMarkup(
  createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(I18nextProvider, { i18n }, createElement('table', null, createElement('tbody', null, createElement(TableEmptyRow, props))))),
)

describe("a list table's empty row", () => {
  it("says the list could not be read, with the server's reason and a retry, instead of an empty list", () => {
    const html = render({ colSpan: 4, resource: 'admin-roles', error: { response: { status: 500, data: { detail: 'database is not reachable' } }, message: 'x' } })
    expect(html).toContain('Could not read the list: database is not reachable')
    expect(html).toContain('data-testid="table-load-error"')
    expect(html).toContain('data-testid="table-load-error-retry"')
    expect(html).not.toContain('No items.')
  })

  it('is the shared empty text when the read worked', () => {
    expect(render({ colSpan: 4, resource: 'admin-roles' })).toContain('No items.')
    expect(render({ colSpan: 4, resource: 'admin-roles', searching: true })).toContain('No results found.')
  })
})
