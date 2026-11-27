import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'

const language = vi.hoisted(() => ({ current: 'en' as 'en' | 'ko' }))
vi.mock('react', async (original) => {
  const { fakeHooks } = await import('@/testing/fakeHooks')
  return { ...await original<typeof import('react')>(), ...fakeHooks }
})
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => {
    const catalog = language.current === 'en' ? en : ko
    return catalog.aiChat[key.split('.')[1] as keyof typeof catalog.aiChat]
  } }),
}))

import { ChatColumns } from './ChatColumns'

const sidebar = createElement('section', { 'data-history': 'kept' }, 'A conversation being renamed')
const messages = createElement('section', { 'data-answer': 'kept' }, 'An answer still arriving')
const draw = () => fakeRender(() => ChatColumns({ sidebar, children: messages }))
const toggle = (tree: unknown) => elementsOf(tree, (p) => p['data-testid'] === 'chat-session-sidebar-toggle')[0]
const panel = (tree: unknown) => elementsOf(tree, (p) => p['data-testid'] === 'chat-session-sidebar-panel')[0]
const press = (tree: unknown) => (toggle(tree).props.onClick as () => void)()

afterEach(() => {
  fakeUnmount()
  language.current = 'en'
})

describe('conversation columns on a narrow window', () => {
  it('starts folded, with a named native button linked to the history panel', () => {
    const tree = draw()
    const button = toggle(tree)
    expect(button.type).toBe('button')
    expect(button.props.type).toBe('button')
    expect(button.props['aria-expanded']).toBe(false)
    expect(button.props['aria-controls']).toBe(panel(tree).props.id)
    expect(textsOf(button).join('')).toBe('Show conversations')
    expect(panel(tree).props.className).toContain('hidden')
  })

  it.each(['en', 'ko'] as const)('opens and folds with matching visible names in %s', (lng) => {
    language.current = lng
    const catalog = lng === 'en' ? en : ko
    let tree = draw()
    press(tree)
    tree = draw()
    expect(toggle(tree).props['aria-expanded']).toBe(true)
    expect(textsOf(toggle(tree)).join('')).toBe(catalog.aiChat.hideConversations)
    expect(String(panel(tree).props.className).split(' ')).toContain('flex')
    expect(String(panel(tree).props.className).split(' ')).not.toContain('hidden')
    press(tree)
    tree = draw()
    expect(toggle(tree).props['aria-expanded']).toBe(false)
    expect(textsOf(toggle(tree)).join('')).toBe(catalog.aiChat.showConversations)
  })

  it('keeps the same history and answer elements mounted across repeated folding', () => {
    for (let i = 0; i < 4; i += 1) {
      const tree = draw()
      expect(panel(tree).props.children).toBe(sidebar)
      expect(elementsOf(tree, (p) => p['data-answer'] === 'kept')[0]).toBe(messages)
      press(tree)
    }
  })

  it('uses native keyboard activation and the shared focus treatment, with a 40 px target', () => {
    const button = toggle(draw())
    expect(button.type).toBe('button')
    expect(button.props.disabled).toBeUndefined()
    expect(button.props.tabIndex).toBeUndefined()
    expect(button.props.onKeyDown).toBeUndefined()
    expect(String(button.props.className).split(' ')).toEqual(expect.arrayContaining(['btn', 'btn-secondary', 'min-h-10', 'min-w-10']))
  })

  it('keeps the existing columns at 1280 px and above, hiding only the extra toggle row', () => {
    const tree = draw()
    expect(panel(tree).props.className).toContain('min-[1280px]:flex')
    const row = elementsOf(tree, (p) => String(p.className).split(' ').includes('min-[1280px]:hidden'))[0]
    expect(elementsOf(row, (p) => p['data-testid'] === 'chat-session-sidebar-toggle')).toHaveLength(1)
    expect(panel(tree).props.className).toContain('w-64')
    expect(elementsOf(tree, (p) => String(p.className).split(' ').includes('min-w-0')).length).toBeGreaterThan(0)
  })

  it('remembers only while this screen stays mounted', () => {
    press(draw())
    expect(toggle(draw()).props['aria-expanded']).toBe(true)
    fakeUnmount()
    expect(toggle(draw()).props['aria-expanded']).toBe(false)
  })
})
