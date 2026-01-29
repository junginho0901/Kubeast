import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
})
