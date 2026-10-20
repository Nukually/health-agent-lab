import { useEffect } from 'react'
import { reportClientError } from '../utils/clientErrorReport.js'

export function useGlobalErrorReporting() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      const error = event.error instanceof Error
        ? event.error
        : new Error(event.message || 'window error')
      reportClientError(error, { phase: 'window-error' })
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      const error = reason instanceof Error
        ? reason
        : new Error(typeof reason === 'string' ? reason : 'unhandled rejection')
      reportClientError(error, { phase: 'unhandledrejection' })
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])
}
