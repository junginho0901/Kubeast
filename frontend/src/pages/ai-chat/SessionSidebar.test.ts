import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { Session } from '@/services/api'
import { SessionSidebar } from './SessionSidebar'

// A conversation being renamed shows two icon buttons beside its title, save and cancel: each one has a name a
// screen reader says, in the page's language.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const session: Session = { id: 's1', title: 'Pods in shop', created_at: '2026-11-26T00:00:00Z', updated_at: '2026-11-26T00:00:00Z', message_count: 2 }
const none = () => {}

const render = (lng: string, editingSessionId: string | null) =>
  renderToStaticMarkup(createElement(SessionSidebar, {
    sessionsList: [session], sessionsLoading: false, sessionsHasNextPage: false, sessionsFetchingNextPage: false,
    fetchNextSessions: none, sessionsScrollRef: createRef<HTMLDivElement>(), sessionsScrollTop: 0, sessionsViewportHeight: 600,
    handleSessionsScroll: none, selectedSessionId: null, createSessionMutation: { isPending: false },
    isMultiSelectMode: false, selectedSessionIds: new Set<string>(), handleToggleMultiSelect: none, handleSelectAll: none,
    handleDeselectAll: none, handleDeleteSelected: none,
    editingSessionId, editingTitle: session.title, setEditingTitle: none, handleEditSession: none, handleSaveEdit: none,
    handleCancelEdit: none, handleSelectSession: none, handleNewChat: none, handleDeleteSession: none,
    contextMenu: null, handleContextMenu: none, handleCloseContextMenu: none, t: i18n.getFixedT(lng),
  }))

// every <button> of the markup: its aria-label and the text inside it, tags left out
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({
    label: /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? null,
    text: inner.replace(/<[^>]*>/g, '').trim(),
  }))

// the buttons of the rename row: those after the title's text field
const renameButtons = (html: string) => {
  const at = html.indexOf('<input type="text"')
  expect(at).toBeGreaterThan(-1)
  return buttons(html.slice(at))
}

describe('the rename row of a conversation', () => {
  it('names its save and cancel buttons in English', () => {
    expect(renameButtons(render('en', 's1'))).toEqual([{ label: 'Save', text: '' }, { label: 'Cancel', text: '' }])
  })

  it('names them in Korean', () => {
    expect(renameButtons(render('ko', 's1'))).toEqual([{ label: '저장', text: '' }, { label: '취소', text: '' }])
  })

  it('leaves no button of the sidebar without a name, renaming or not', () => {
    for (const lng of ['en', 'ko']) {
      for (const editing of ['s1', null]) {
        const nameless = buttons(render(lng, editing)).filter((b) => !b.label && !b.text)
        expect(nameless).toEqual([])
      }
    }
  })
})
