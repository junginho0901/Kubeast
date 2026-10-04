import { defineConfig, devices } from '@playwright/test'

// Opt-in action suite (e2e/actions): E2E_ACTIONS=1 adds the seed + actions projects. Playwright runs every
// project by default, so the gate keeps `npx playwright test` unchanged; run it with --project=actions.
const ACTIONS = process.env.E2E_ACTIONS === '1'

// E2E config — runs against the kind cluster's gateway (port 8000).
// Snapshots are committed-equivalent baselines that the refactor PRs
// must not change. The baseline pass is captured on `main`; subsequent
// runs on a feature branch must match pixel-for-pixel (within
// maxDiffPixels tolerance for sub-pixel font rendering / animation
// frames that survived the wait).
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // single-cluster; serialize to keep K8s state stable
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',

  expect: {
    // Animation / 1px sub-pixel rounding is the main diff source.
    // 100 pixel tolerance is empirically below "any meaningful UI change".
    toHaveScreenshot: {
      maxDiffPixels: 100,
      // Animations are explicitly disabled per-test via `animations: 'disabled'`.
      threshold: 0.2,
    },
  },

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Avoid running into self-signed cert errors on kind.
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: '.auth/user.json',
        // Copy 버튼 검증 (ai-chat.spec) 을 위해 clipboard 접근 허용
        permissions: ['clipboard-read', 'clipboard-write'],
      },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
    ...(ACTIONS
      ? [
          {
            name: 'actions-seed',
            testDir: './actions',
            testMatch: /seed\.setup\.ts/,
          },
          {
            name: 'actions',
            testDir: './actions',
            testIgnore: /seed\.setup\.ts/,
            timeout: 120_000, // drivers poll the cluster for up to 20 s and a drain waits 8 s
            use: {
              ...devices['Desktop Chrome'],
              // Playwright Test defaults both to 0 (unbounded); the drivers expect a missing element or a
              // page that never goes network-idle to fail fast, not to eat the whole test timeout.
              actionTimeout: 15_000,
              navigationTimeout: 30_000,
              viewport: { width: 1440, height: 900 },
              locale: 'en-US',
              storageState: '.auth/user.json',
              permissions: ['clipboard-read', 'clipboard-write'], // Monaco edits paste through the clipboard
            },
            dependencies: ['setup', 'actions-seed'],
          },
        ]
      : []),
  ],
})
