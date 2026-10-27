import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { ToastProvider } from './components/Toast.tsx'
import './components/ui.css'
import './i18n'
import './index.css'
import { JobsProvider } from './shell/JobsProvider.tsx'
import { migrateStickyState } from './shell/migrateStickyState.ts'
import './shell/workspace.css'
import { WorkspaceProvider } from './shell/WorkspaceContext.tsx'
import { applyThemeMode, readThemeMode } from './theme/themeMode.ts'

// Split the old shared `ft.symbols` universe key into `ft.chartSymbol` +
// `ft.extraSymbols` before anything reads either -- see the function's own
// doc comment. A no-op once it has run once.
migrateStickyState()

// Before the first paint, not in an effect: with no `data-theme` on <html>,
// the CSS follows the OS, so a viewer who chose light on a dark machine would
// otherwise see the dark panel flash past on every load.
applyThemeMode(readThemeMode())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <WorkspaceProvider>
            <JobsProvider>
              <ToastProvider>
                <App />
              </ToastProvider>
            </JobsProvider>
          </WorkspaceProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
