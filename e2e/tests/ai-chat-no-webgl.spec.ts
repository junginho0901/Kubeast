import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// A browser that cannot make a WebGL context (GPU off, many remote desktops) still gets the AI Chat page. The welcome
// screen's particle logo threw while three.js made its renderer, and the whole page went blank, the sidebar with it;
// now ChatWelcome draws the static icon there (WelcomeParticles).
test.use({ launchOptions: { args: ['--disable-gpu', '--disable-webgl', '--disable-webgl2'] } })

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))

test('AI Chat without WebGL keeps its sidebar, welcome screen, questions and input', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/ai-chat')

  // The browser has no WebGL at all, or the test shows nothing.
  expect(await page.evaluate(() => ['webgl', 'webgl2'].map((kind) => document.createElement('canvas').getContext(kind) === null)))
    .toEqual([true, true])

  const heading = page.locator('h2', { hasText: EN.aiChat.emptyTitle })
  await expect(heading).toHaveText(EN.aiChat.emptyTitle)
  const welcome = heading.locator('xpath=..')
  expect(await welcome.locator('.grid button').allInnerTexts()).toEqual(EN.aiChat.quickQuestions)
  expect(await welcome.locator('img[src="/icon.svg"]').count()).toBe(1)
  expect(await welcome.locator('canvas').count()).toBe(0)
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(1)
  await expect(page.getByPlaceholder(/message/i)).toBeEditable()
  expect(errors).toEqual([])
})
