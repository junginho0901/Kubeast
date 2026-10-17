import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './i18n'
import './index.css'

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.type === 'cancelation') e.preventDefault()
})

// Route chunks are hashed; a tab opened before a deploy may reference chunks
// that no longer exist. Reload to pick up the new index.html.
window.addEventListener('vite:preloadError', () => {
  window.location.reload()
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
