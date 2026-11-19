import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Plugin } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// KUBEAST_PSEUDO_LOCALE=1 puts the pseudo text of src/i18n/pseudo.ts on every string (the stretched-text check of
// v0.8.0). Without it the plugin is not in the list and the page and its bundle are what they were.
const pseudoLocale = (): Plugin => ({
  name: 'kubeast-pseudo-locale',
  transformIndexHtml: {
    order: 'pre',
    handler: () => [{
      tag: 'script',
      attrs: { type: 'module' },
      children: "import i18n from '/src/i18n/index.ts'\nimport { turnOnPseudoLocale } from '/src/i18n/pseudo.ts'\nturnOnPseudoLocale(i18n)",
      injectTo: 'head',
    }],
  },
})

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), ...(process.env.KUBEAST_PSEUDO_LOCALE === '1' ? [pseudoLocale()] : [])],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // MSA 구조: API Gateway(nginx)가 모든 요청을 라우팅하므로 프록시 불필요
    // Gateway가 frontend:5173으로 프록시하고, API 요청은 해당 서비스로 라우팅
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
