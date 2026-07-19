import './configureMonaco'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useBundleStore } from './stores/bundleStore'
import { hydrateRendererPrefsFromMain } from './services/rendererPrefsSync'
import { buildRegistryContextWindowMap } from './data/providerRegistry'
import { setRegistryContextWindows } from './services/electronAPI'
import { useLayoutStore } from './stores/useLayoutStore'
import { isBrowserMode, getStoredConnection } from './services/h5/h5Connection'
import { installBrowserElectronApiShim } from './services/h5/browserElectronApiShim'
import { installH5MobileViewport } from './services/h5/mobileViewport'
import { H5BrowserGate } from './components/H5/H5BrowserGate'
import './styles/h5-mobile.css'

if (import.meta.env.DEV) {
  console.debug('[Main] bootstrap')
}

if (import.meta.env.VITE_E2E_HOOKS === '1') {
  void import('./e2e/testHooks').then((module) => module.mountE2ETestHooks())
}

const rootElement = document.getElementById('root')

if (!rootElement) {
  console.error('[Main] Root element not found!')
  throw new Error('Root element not found')
}

function runRendererBoot(): void {
  void useBundleStore.getState().initialize()
  void hydrateRendererPrefsFromMain()
  void setRegistryContextWindows(buildRegistryContextWindowMap()).catch((error) => {
    console.warn('[Main] Failed to push registry context windows:', error)
  })
}

function connectAndEnter(connection: ReturnType<typeof getStoredConnection>): void {
  if (!connection) return
  installBrowserElectronApiShim(connection)
  installH5MobileViewport()
  useLayoutStore.setState({
    aiChatVisible: true,
    sidebarVisible: false,
    terminalVisible: false,
  })
  runRendererBoot()
}

const root = createRoot(rootElement)

if (!isBrowserMode()) {
  runRendererBoot()
  root.render(<App />)
} else {
  root.render(<H5BrowserGate onEnter={connectAndEnter} />)
}
