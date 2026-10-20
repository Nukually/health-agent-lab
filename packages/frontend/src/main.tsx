import './utils/polyfills.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import AppErrorBoundary from './components/AppErrorBoundary.js'
import { captureChannelCodeFromCurrentUrl } from './utils/channelAttribution.js'
import { captureDoctorInviteFromCurrentUrl } from './utils/doctorInvite.js'
import './styles/globals.css'

function setupAppViewportHeight() {
  const root = document.documentElement
  const sync = () => {
    root.style.setProperty('--app-height', `${window.innerHeight}px`)
  }
  sync()
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
}

setupAppViewportHeight()
captureChannelCodeFromCurrentUrl()
captureDoctorInviteFromCurrentUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)

function notifyNativeAppReady() {
  const postReady = () => {
    window.webkit?.messageHandlers?.cxAppReady?.postMessage?.({
      type: 'ready',
      href: window.location.href,
    })
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(postReady)
  })
}

notifyNativeAppReady()
