import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { PageContextProvider } from '@/components/PageContextProvider'
import AdminAIUsage from '../AdminAIUsage'
import AdminAudit from '../AdminAudit'
import ClusterHygiene from './ClusterHygiene'
import Investigations from './Investigations'
import SessionRecordings from './SessionRecordings'

// The first paint of a page, before any answer.
function render(page: ComponentType): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = createElement(PageContextProvider, null, createElement(page))
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, screen)))
}

// The classes of the page's outer box, and whether a list footer holds the rows-per-page choice.
const outer = (markup: string) => (/^<div class="([^"]*)"/.exec(markup)?.[1] ?? '').split(/\s+/)
const pagerChoice = (markup: string, testId: string) => new RegExp(`data-testid="${testId}"[^>]*><div[^>]*><div[^>]*data-testid="page-size"`).test(markup)

describe('the admin record lists fit the screen', () => {
  const pages: [string, ComponentType, string][] = [
    ['AI usage', AdminAIUsage, 'ai-usage-pager'],
    ['Audit logs', AdminAudit, 'audit-pager'],
    ['Cluster hygiene', ClusterHygiene, 'hygiene-pager'],
    ['Investigations', Investigations, 'investigations-pager'],
    ['Session recordings', SessionRecordings, 'recordings-pager'],
  ]
  for (const [name, page, pager] of pages) {
    it(`${name}: the page is the screen's height and its footer offers Fit and the fixed sizes`, () => {
      const markup = render(page)
      const classes = outer(markup)
      expect({ height: classes.includes('h-[calc(100vh-4rem)]'), scrolls: classes.includes('page-scrolls') }).toEqual({ height: true, scrolls: false })
      expect(pagerChoice(markup, pager)).toBe(true)
      expect(markup.match(/data-testid="page-size"/g)?.length).toBe(1)
    })
  }
})
