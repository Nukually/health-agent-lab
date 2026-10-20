import { Navigate, useLocation } from 'react-router-dom'
import { useStore } from '../stores/index.js'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const token = useStore((s) => s.token)
  const needsProfile = useStore((s) => s.needsProfile)

  if (!token) {
    return <Navigate to="/login" replace />
  }

  if (needsProfile && location.pathname !== '/profile') {
    return <Navigate to="/profile" replace />
  }

  return <>{children}</>
}
