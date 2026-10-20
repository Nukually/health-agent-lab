import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Chat from './pages/Chat.js'
import AuthGuard from './components/AuthGuard.js'
import MobileShell from './components/MobileShell.js'
import { useVisualViewportKeyboard } from './hooks/useVisualViewportKeyboard.js'
import { useLegacyAndroidInsets } from './hooks/useLegacyAndroidInsets.js'
import { useGlobalErrorReporting } from './hooks/useGlobalErrorReporting.js'
import { useFontEnvironmentTelemetry } from './hooks/useFontEnvironmentTelemetry.js'
import { installInteractiveSelectionGuard } from './utils/selection.js'
import {
  bindNativePushDevice,
  getNativePushInfo,
  normalizeNativeRoute,
} from './lib/nativePush.js'
import { clearNativeAuthToken, hasNativeAuthBridge, setNativeAuthToken } from './lib/nativeAuth.js'
import { initNativeRum, reportNativeFirstScreen } from './lib/nativeRum.js'
import {
  ensureNativeBridgeBootstrap,
  hasNativeBridge,
  type NativeBridgeEvent,
} from './lib/nativeBridge.js'
import { isFeatureEnabled } from '@health-agent/shared'
import { syncPendingScheduledTaskCalendars } from './lib/scheduledTaskCalendarSync.js'
import { useStore } from './stores/index.js'
import { captureChannelCodeFromCurrentUrl } from './utils/channelAttribution.js'
import { captureDoctorInviteFromCurrentUrl, readStoredDoctorInviteId } from './utils/doctorInvite.js'
import { refreshClientExperienceSnapshot } from './clientExperience.js'
import { trackEvent } from './services/tracking.js'
import { getCurrentWebSessionId } from './services/trackingContext.js'

const Login = lazy(() => import('./pages/Login.js'))
const Profile = lazy(() => import('./pages/Profile.js'))
const MedicalRecords = lazy(() => import('./pages/MedicalRecords.js'))
const Materials = lazy(() => import('./pages/Materials.js'))
const CheckInRecords = lazy(() => import('./pages/CheckInRecords.js'))
const ScheduledTasks = lazy(() => import('./pages/ScheduledTasks.js'))
const MyDoctor = lazy(() => import('./pages/MyDoctor.js'))
const DoctorBind = lazy(() => import('./pages/DoctorBind.js'))
const HealthEducationPlaza = lazy(() => import('./pages/HealthEducationPlaza.js'))
const MaterialsAdmin = lazy(() => import('./pages/MaterialsAdmin.js'))
const SharedView = lazy(() => import('./pages/SharedView.js'))
const AccountSecurity = lazy(() => import('./pages/AccountSecurity.js'))
const DeletionPending = lazy(() => import('./pages/DeletionPending.js'))
const ReadingSettings = lazy(() => import('./pages/ReadingSettings.js'))

function reportFirstScreenAfterPaint() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      reportNativeFirstScreen().catch(() => undefined)
    })
  })
}

function NativePushEventHandler() {
  const navigate = useNavigate()
  const token = useStore((s) => s.token)
  const userId = useStore((s) => s.user?.id)

  useEffect(() => {
    ensureNativeBridgeBootstrap()

    function syncNativePushAuth() {
      if (!token) {
        clearNativeAuthToken().catch(() => undefined)
        return
      }

      initNativeRum(userId).catch(() => undefined)

      setNativeAuthToken(token)
        .then((nativeDirectBindEnabled) => {
          if (nativeDirectBindEnabled) {
            // Native 直绑架构：H5 只透传 JWT + 触发权限请求，
            // registrationId 由 Native 直接绑定后端。
            return getNativePushInfo({ requestPermissionIfNeeded: true }).then(() => undefined)
          }

          // 兼容旧壳：仍由 H5 读取 push.getInfo 后调用后端 bind。
          return bindNativePushDevice({ requestPermissionIfNeeded: true }).then(() => undefined)
        })
        .then(() => {
          syncPendingScheduledTaskCalendars().catch(() => undefined)
        })
        .catch(() => undefined)
    }

    function handleNativeReady() {
      syncNativePushAuth()
      reportFirstScreenAfterPaint()
      trackEvent('h5_native_bridge_ready', {
        eventVersion: '1.0',
        entityType: 'native_bridge',
        entityId: window.location.pathname || '/',
      })
    }

    function handleNativeEvent(event: Event) {
      const detail = (event as CustomEvent<NativeBridgeEvent<Record<string, unknown>>>).detail
      if (!detail || detail.module !== 'push') return

      if (detail.event === 'open') {
        const route = normalizeNativeRoute(detail.data?.route)
        if (route) navigate(route)
        return
      }

      if (detail.event === 'registrationChanged' || detail.event === 'permissionChanged') {
        if (hasNativeAuthBridge()) {
          // Native 直绑架构下，push 状态变化只作为 UI 通知事件；
          // bind/upsert 由 Native PushManager 的 requestSync 状态机独立完成。
          return
        }
        syncNativePushAuth()
      }
    }

    window.addEventListener('cx-native-ready', handleNativeReady)
    window.addEventListener('cx-native-event', handleNativeEvent)

    if (hasNativeBridge()) {
      syncNativePushAuth()
      reportFirstScreenAfterPaint()
    }

    return () => {
      window.removeEventListener('cx-native-ready', handleNativeReady)
      window.removeEventListener('cx-native-event', handleNativeEvent)
    }
  }, [navigate, token, userId])

  return null
}

function TrackingRouteEvents() {
  const location = useLocation()

  useEffect(() => {
    trackEvent('h5_session_started', {
      eventVersion: '1.0',
      entityType: 'web_session',
      entityId: getCurrentWebSessionId(),
    })
  }, [])

  useEffect(() => {
    trackEvent('page_view', {
      eventVersion: '1.0',
      entityType: 'route',
      entityId: location.pathname,
      properties: { route: location.pathname },
    })
  }, [location.pathname])

  return null
}

function DoctorInviteBinder() {
  const navigate = useNavigate()
  const token = useStore((s) => s.token)
  const needsProfile = useStore((s) => s.needsProfile)

  useEffect(() => {
    captureDoctorInviteFromCurrentUrl()
  }, [])

  useEffect(() => {
    if (!token || needsProfile) return
    if (readStoredDoctorInviteId() && window.location.pathname !== '/doctor-bind') {
      navigate('/doctor-bind', { replace: true })
    }
  }, [navigate, token, needsProfile])

  return null
}

function FeatureRoute({ feature, children }: { feature: Parameters<typeof isFeatureEnabled>[1]; children: ReactNode }) {
  const featureSnapshot = useStore((s) => s.features)
  return isFeatureEnabled(featureSnapshot, feature) ? children : <Navigate to="/chat" replace />
}

export default function App() {
  useLegacyAndroidInsets()
  useVisualViewportKeyboard()
  useGlobalErrorReporting()
  useFontEnvironmentTelemetry()
  useEffect(() => installInteractiveSelectionGuard(), [])
  useEffect(() => {
    captureChannelCodeFromCurrentUrl()
  }, [])
  useEffect(() => {
    refreshClientExperienceSnapshot().catch(() => undefined)
  }, [])
  return (
    <BrowserRouter>
      <NativePushEventHandler />
      <TrackingRouteEvents />
      <DoctorInviteBinder />
      <MobileShell>
      <Suspense fallback={null}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/doctor-bind" element={<DoctorBind />} />
        <Route path="/s/:token" element={<SharedView />} />
        <Route
          path="/profile"
          element={
            <AuthGuard>
              <Profile />
            </AuthGuard>
          }
        />
        <Route
          path="/medical-records"
          element={
            <AuthGuard>
              <MedicalRecords />
            </AuthGuard>
          }
        />
	        <Route
	          path="/materials"
	          element={
	            <AuthGuard>
	              <Materials />
	            </AuthGuard>
	          }
	        />
        <Route
          path="/check-ins"
	          element={
	            <AuthGuard>
	              <FeatureRoute feature="checkInRecords">
	                <CheckInRecords />
	              </FeatureRoute>
	            </AuthGuard>
          }
        />
        <Route
          path="/scheduled-tasks"
          element={
            <AuthGuard>
              <FeatureRoute feature="agentScheduledTasks">
                <ScheduledTasks />
              </FeatureRoute>
            </AuthGuard>
          }
        />
        <Route
          path="/scheduled-tasks/:taskId"
          element={
            <AuthGuard>
              <FeatureRoute feature="agentScheduledTasks">
                <ScheduledTasks />
              </FeatureRoute>
            </AuthGuard>
          }
        />
        <Route
          path="/my-doctor"
          element={
            <AuthGuard>
              <FeatureRoute feature="myDoctorEntry">
                <MyDoctor />
              </FeatureRoute>
            </AuthGuard>
          }
        />
        <Route
          path="/health-education"
          element={
            <AuthGuard>
              <FeatureRoute feature="healthEducationPlaza">
                <HealthEducationPlaza />
              </FeatureRoute>
            </AuthGuard>
          }
        />
        <Route
          path="/materials-admin"
          element={
            <AuthGuard>
              <FeatureRoute feature="materialUploadAdmin">
                <MaterialsAdmin />
              </FeatureRoute>
            </AuthGuard>
          }
        />
        {/* backward compat redirect */}
        <Route path="/medical-record" element={<Navigate to="/profile" replace />} />
        <Route
          path="/account-security"
          element={
            <AuthGuard>
              <AccountSecurity />
            </AuthGuard>
          }
        />
        <Route
          path="/reading-settings"
          element={
            <AuthGuard>
              <ReadingSettings />
            </AuthGuard>
          }
        />
        <Route
          path="/deletion-pending"
          element={
            <AuthGuard>
              <DeletionPending />
            </AuthGuard>
          }
        />
        <Route
          path="/chat"
          element={
            <AuthGuard>
              <Chat />
            </AuthGuard>
          }
        />
        <Route
          path="/chat/:sessionId"
          element={
            <AuthGuard>
              <Chat />
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
      </Suspense>
      </MobileShell>
    </BrowserRouter>
  )
}
