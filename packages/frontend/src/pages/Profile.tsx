import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../services/api.js'
import { useStore } from '../stores/index.js'
import { unbindNativePushDevice } from '../lib/nativePush.js'
import DateWheelPicker from '../components/ui/DateWheelPicker.js'
import ClearMedicalDataDialog from '../components/account/ClearMedicalDataDialog.js'
import DeleteAccountWizard from '../components/account/DeleteAccountWizard.js'
import { reportAnalyticsEvent } from '../services/analytics.js'
import {
  CURRENT_CONCERN_OPTIONS,
  hasCompleteUserProfile,
  type ApiResponse,
  type CurrentConcern,
  type ProfileResponse,
  type UserProfile,
} from '@health-agent/shared'
import { createClientId } from '../utils/id.js'
import { readStoredDoctorInviteId } from '../utils/doctorInvite.js'
import type { ChatFontScale } from '../stores/slices/settings.js'

const READING_OPTIONS: Array<{
  value: ChatFontScale
  label: string
  title: string
  desc: string
  previewSize: number
}> = [
  { value: 'small', label: '小', title: '紧凑', desc: '显示更多', previewSize: 24 },
  { value: 'medium', label: '中', title: '标准', desc: '推荐阅读字号', previewSize: 30 },
  { value: 'large', label: '大', title: '舒适', desc: '适合长文', previewSize: 36 },
]

function maskPhone(phone?: string | null): string {
  if (!phone) return '未绑定'
  if (phone.length < 7) return phone
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

function formatIsoBirthday(value?: string | null): string {
  if (!value) return ''
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${Number(year)}年${Number(month)}月${Number(day)}日`
}

export default function Profile() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const isEditMode = searchParams.get('mode') === 'edit'
  const returnSessionId = searchParams.get('returnSessionId')
  const shouldReturnToSettings = searchParams.get('returnToSettings') === '1' || !!returnSessionId

  const authUser = useStore((s) => s.user)
  const logout = useStore((s) => s.logout)
  const setUserProfile = useStore((s) => s.setUserProfile)
  const updateAuthUserProfile = useStore((s) => s.updateAuthUserProfile)
  const skipProfile = useStore((s) => s.skipProfile)
  const needsProfile = useStore((s) => s.needsProfile)
  const requireCompleteProfile = useStore((s) => s.requireCompleteProfile)
  const chatFontScale = useStore((s) => s.chatFontScale)
  const setChatFontScale = useStore((s) => s.setChatFontScale)
  const shouldLoadProfile = isEditMode || needsProfile
  const isRequiredProfileFlow = requireCompleteProfile && !isEditMode
  const returnToChatPath = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
  const returnToSettingsState = shouldReturnToSettings ? { openSidebar: true } : undefined

  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(shouldLoadProfile)
  const [error, setError] = useState('')
  const [nickname, setNickname] = useState('')
  const [birthYear, setBirthYear] = useState<number | ''>('')
  const [birthMonth, setBirthMonth] = useState<number | ''>('')
  const [birthDay, setBirthDay] = useState<number | ''>('')
  const [gender, setGender] = useState<'男' | '女' | ''>('')
  const [currentConcern, setCurrentConcern] = useState<CurrentConcern | ''>('')
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [currentConcernDropdownOpen, setCurrentConcernDropdownOpen] = useState(false)
  const [clearMedicalDataOpen, setClearMedicalDataOpen] = useState(false)
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(searchParams.get('delete') === '1')
  const currentConcernDropdownRef = useRef<HTMLDivElement>(null)
  const [fieldErrors, setFieldErrors] = useState({
    nickname: false,
    birthday: false,
    gender: false,
    currentConcern: false,
  })
  const analyticsFlowIdRef = useRef(createClientId('personal-info'))
  const analyticsStartedAtRef = useRef(Date.now())
  const analyticsRecordedRef = useRef(false)
  const analyticsModeRef = useRef(isEditMode ? 'edit' : 'onboarding')
  const analyticsRequiredRef = useRef(isRequiredProfileFlow)

  useEffect(() => {
    analyticsModeRef.current = isEditMode ? 'edit' : 'onboarding'
    analyticsRequiredRef.current = isRequiredProfileFlow
  }, [isEditMode, isRequiredProfileFlow])

  function recordPersonalInfoTime(result: 'saved' | 'skipped' | 'cancelled' | 'left') {
    if (analyticsRecordedRef.current) return
    analyticsRecordedRef.current = true

    const startedAtMs = analyticsStartedAtRef.current
    const endedAtMs = Date.now()
    reportAnalyticsEvent('personal_info_time', {
      dedupeKey: analyticsFlowIdRef.current,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      properties: {
        mode: analyticsModeRef.current,
        required: analyticsRequiredRef.current,
        result,
      },
    })
  }

  useEffect(() => {
    return () => recordPersonalInfoTime('left')
    // 只在页面卸载时兜底记录一次；运行时依赖用 ref 读取，避免重复注册 cleanup。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!shouldLoadProfile) return
    setInitialLoading(true)
    api.get<ApiResponse<ProfileResponse>>('/medical')
      .then((res) => {
        if (!res.data?.user) return
        const { user } = res.data
        if (user.nickname) setNickname(user.nickname)
        if (user.birthday) {
          const [y, m, d] = user.birthday.split('-').map(Number)
          if (y) setBirthYear(y)
          if (m) setBirthMonth(m)
          if (d) setBirthDay(d)
        }
        if (user.gender) setGender(user.gender as '男' | '女')
        if (user.currentConcern) setCurrentConcern(user.currentConcern)
      })
      .catch(() => setError('加载信息失败'))
      .finally(() => setInitialLoading(false))
  }, [shouldLoadProfile])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        currentConcernDropdownRef.current &&
        !currentConcernDropdownRef.current.contains(e.target as Node)
      ) {
        setCurrentConcernDropdownOpen(false)
      }
    }
    if (currentConcernDropdownOpen) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [currentConcernDropdownOpen])

  function buildBirthday(): string | undefined {
    if (!birthYear || !birthMonth || !birthDay) return undefined
    const m = String(birthMonth).padStart(2, '0')
    const d = String(birthDay).padStart(2, '0')
    return `${birthYear}-${m}-${d}`
  }

  const trimmedNickname = nickname.trim()
  const birthday = buildBirthday()
  const profileDraft = {
    nickname: trimmedNickname || null,
    birthday: birthday || null,
    gender: gender || null,
    currentConcern: currentConcern || null,
  }
  const isProfileComplete = hasCompleteUserProfile(profileDraft)
  const missingRequiredFields = {
    nickname: !trimmedNickname,
    birthday: !birthday,
    gender: !gender,
    currentConcern: !currentConcern,
  }

  async function savePersonalInfo(): Promise<boolean> {
    setError('')
    if (isRequiredProfileFlow && !isProfileComplete) {
      setFieldErrors(missingRequiredFields)
      const missingFields: string[] = []
      if (!trimmedNickname) missingFields.push('昵称')
      if (!birthday) missingFields.push('出生日期')
      if (!gender) missingFields.push('性别')
      if (!currentConcern) missingFields.push('当前关注情况')
      setError(`请完整填写${missingFields.join('、')}`)
      return false
    }
    if (!currentConcern) {
      setFieldErrors((prev) => ({ ...prev, currentConcern: true }))
      setError('请选择当前关注情况')
      return false
    }
    setFieldErrors({
      nickname: false,
      birthday: false,
      gender: false,
      currentConcern: false,
    })
    const payload: Record<string, unknown> = {}
    if (trimmedNickname) payload.nickname = trimmedNickname
    if (birthday) payload.birthday = birthday
    if (gender) payload.gender = gender
    payload.currentConcern = currentConcern
    if (isEditMode && returnSessionId) payload.sessionId = returnSessionId

    setLoading(true)
    try {
      const res = await api.put<ApiResponse<UserProfile>>('/medical/profile', payload)
      if (res.data) {
        setUserProfile({
          nickname: res.data.nickname || undefined,
          birthday: res.data.birthday || undefined,
          gender: res.data.gender || undefined,
          currentConcern: res.data.currentConcern || undefined,
        })
        updateAuthUserProfile({
          nickname: res.data.nickname,
          birthday: res.data.birthday,
          gender: res.data.gender,
          currentConcern: res.data.currentConcern,
        })
      }
      return true
    } catch (err: any) {
      setError(err.message || '保存失败')
      return false
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    const ok = await savePersonalInfo()
    if (!ok) return
    const shouldShowFirstActivationWelcome = !isEditMode && needsProfile
    recordPersonalInfoTime('saved')
    skipProfile()
    if (isEditMode) {
      navigate(returnToChatPath, { state: returnToSettingsState })
      return
    }
    if (readStoredDoctorInviteId()) {
      navigate('/doctor-bind', { replace: true })
      return
    }
    navigate('/chat', {
      replace: true,
      state: shouldShowFirstActivationWelcome ? { showFirstActivationWelcome: true } : undefined,
    })
  }

  function handleSkip() {
    const shouldShowFirstActivationWelcome = !isEditMode && needsProfile
    recordPersonalInfoTime('skipped')
    skipProfile()
    if (!isEditMode && readStoredDoctorInviteId()) {
      navigate('/doctor-bind', { replace: true })
      return
    }
    navigate('/chat', {
      replace: true,
      state: shouldShowFirstActivationWelcome ? { showFirstActivationWelcome: true } : undefined,
    })
  }

  function handleBack() {
    recordPersonalInfoTime('cancelled')
    navigate(returnToChatPath, { state: returnToSettingsState })
  }

  function handleLogout() {
    unbindNativePushDevice({ keepalive: true })
      .catch(() => undefined)
      .finally(() => {
        logout()
        navigate('/login', { replace: true })
      })
  }

  const birthdayDisplay = birthYear && birthMonth && birthDay
    ? `${birthYear}年${birthMonth}月${birthDay}日`
    : ''
  const currentConcernLabel = CURRENT_CONCERN_OPTIONS.find((option) => option.value === currentConcern)?.label ?? ''
  const savedBirthdayDisplay = birthdayDisplay || formatIsoBirthday(authUser?.birthday)

  if (initialLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>加载中...</div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.scrollArea}>
        {isEditMode && (
          <button
            style={styles.backBtn}
            onClick={handleBack}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>返回</span>
          </button>
        )}

        <div style={styles.form}>
          {!isEditMode && (
            <div style={styles.header}>
              <h1 style={styles.title}>个人信息</h1>
              <p style={styles.subtitle}>
                {needsProfile
                  ? '首次登录请完整填写昵称、出生日期、当前关注情况和性别后，再进入对话。'
                  : '您可以先填写个人信息，也可以直接进入对话。'}
              </p>
            </div>
          )}

          <section style={styles.sectionCard}>
            {isEditMode && (
              <div style={styles.sectionHeading}>
                <div>
                  <h2 style={styles.sectionTitle}>个人信息</h2>
                  <p style={styles.sectionSubtitle}>查看和编辑基础资料</p>
                </div>
                <span style={styles.sectionPill}>{savedBirthdayDisplay || '待完善'}</span>
              </div>
            )}

          <div>
            <label
              style={{
                ...styles.label,
                ...(fieldErrors.nickname ? styles.labelError : {}),
              }}
            >
              {isRequiredProfileFlow ? '昵称（必填）' : '昵称'}
            </label>
            <input
              style={{
                ...styles.input,
                ...(fieldErrors.nickname ? styles.fieldControlError : {}),
              }}
              placeholder="请输入您的昵称"
              value={nickname}
              onChange={(e) => {
                const nextValue = e.target.value
                setNickname(nextValue)
                if (fieldErrors.nickname && nextValue.trim()) {
                  setFieldErrors((prev) => ({ ...prev, nickname: false }))
                }
              }}
            />
          </div>

          <div>
            <label
              style={{
                ...styles.label,
                ...(fieldErrors.birthday ? styles.labelError : {}),
              }}
            >
              {isRequiredProfileFlow ? '出生日期（必填）' : '出生日期'}
            </label>
            <button
              style={{
                ...styles.datePickerTrigger,
                color: birthdayDisplay
                  ? 'var(--color-text)'
                  : fieldErrors.birthday
                    ? 'var(--color-error)'
                    : 'var(--color-text-muted)',
                ...(fieldErrors.birthday ? styles.fieldControlError : {}),
              }}
              onClick={() => setDatePickerOpen(true)}
              type="button"
            >
              <span style={{ flex: 1, textAlign: 'left' }}>{birthdayDisplay || '请选择出生日期'}</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke={fieldErrors.birthday ? 'var(--color-error)' : 'var(--color-text-muted)'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </button>
            <DateWheelPicker
              open={datePickerOpen}
              onClose={() => setDatePickerOpen(false)}
              value={{ year: birthYear, month: birthMonth, day: birthDay }}
              onChange={({ year, month, day }) => {
                setBirthYear(year)
                setBirthMonth(month)
                setBirthDay(day)
                if (fieldErrors.birthday && year && month && day) {
                  setFieldErrors((prev) => ({ ...prev, birthday: false }))
                }
              }}
            />
          </div>

          <div>
            <label
              style={{
                ...styles.label,
                ...(fieldErrors.currentConcern ? styles.labelError : {}),
              }}
            >
              {isRequiredProfileFlow ? '当前关注情况（必填）' : '当前关注情况'}
            </label>
            <div ref={currentConcernDropdownRef} style={styles.multiSelectWrapper}>
              <button
                style={{
                  ...styles.multiSelectTrigger,
                  ...(fieldErrors.currentConcern ? styles.fieldControlError : {}),
                }}
                onClick={() => setCurrentConcernDropdownOpen(!currentConcernDropdownOpen)}
                type="button"
                aria-expanded={currentConcernDropdownOpen}
              >
                <span
                  style={{
                    ...styles.singleSelectValue,
                    color: currentConcern
                      ? 'var(--color-text)'
                      : fieldErrors.currentConcern
                        ? 'var(--color-error)'
                        : 'var(--color-text-muted)',
                  }}
                >
                  {currentConcern ? currentConcernLabel : '请选择当前关注情况'}
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={fieldErrors.currentConcern ? 'var(--color-error)' : 'var(--color-text-muted)'}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    flexShrink: 0,
                    transform: currentConcernDropdownOpen ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                    marginLeft: 8,
                  }}
                  aria-hidden
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {currentConcernDropdownOpen && (
                <div style={styles.concernPanel} role="listbox" aria-label="关注情况">
                  {CURRENT_CONCERN_OPTIONS.map((option) => {
                    const checked = currentConcern === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={checked}
                        onClick={() => {
                          setCurrentConcern(option.value)
                          setCurrentConcernDropdownOpen(false)
                          if (fieldErrors.currentConcern) {
                            setFieldErrors((prev) => ({ ...prev, currentConcern: false }))
                          }
                        }}
                        style={checked ? { ...styles.dropdownOption, ...styles.dropdownOptionChecked } : styles.dropdownOption}
                      >
                        <span>{option.label}</span>
                        {checked && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div>
            <label
              style={{
                ...styles.label,
                ...(fieldErrors.gender ? styles.labelError : {}),
              }}
            >
              {isRequiredProfileFlow ? '性别（必填）' : '性别'}
            </label>
            <div style={styles.genderRow}>
              <button
                style={{
                  ...styles.genderBtn,
                  ...(fieldErrors.gender ? styles.fieldControlError : {}),
                  ...(gender === '女' ? styles.genderBtnActive : {}),
                }}
                onClick={() => {
                  setGender('女')
                  if (fieldErrors.gender) {
                    setFieldErrors((prev) => ({ ...prev, gender: false }))
                  }
                }}
                type="button"
              >
                <svg style={styles.genderIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="9" r="5" />
                  <line x1="12" y1="14" x2="12" y2="21" />
                  <line x1="9" y1="18" x2="15" y2="18" />
                </svg>
                <span>女性</span>
              </button>
              <button
                style={{
                  ...styles.genderBtn,
                  ...(fieldErrors.gender ? styles.fieldControlError : {}),
                  ...(gender === '男' ? styles.genderBtnActive : {}),
                }}
                onClick={() => {
                  setGender('男')
                  if (fieldErrors.gender) {
                    setFieldErrors((prev) => ({ ...prev, gender: false }))
                  }
                }}
                type="button"
              >
                <svg style={styles.genderIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="10" cy="14" r="5" />
                  <line x1="14" y1="10" x2="20" y2="4" />
                  <polyline points="15 4 20 4 20 9" />
                </svg>
                <span>男性</span>
              </button>
            </div>
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            style={{ ...styles.primaryBtn, opacity: loading ? 0.5 : 1 }}
            onClick={handleSave}
            disabled={loading}
          >
            {loading ? '保存中...' : isEditMode ? '保存' : '保存并进入对话'}
          </button>

          {isEditMode ? (
            <button
              style={styles.secondaryBtn}
              onClick={handleBack}
            >
              取消
            </button>
          ) : !needsProfile ? (
            <button style={styles.secondaryBtn} onClick={handleSkip}>
              跳过，直接进入对话
            </button>
          ) : null}
          </section>

          {isEditMode && (
            <>
              <section style={styles.sectionCard}>
                <div style={styles.sectionHeading}>
                  <div>
                    <h2 style={styles.sectionTitle}>阅读设置</h2>
                    <p style={styles.sectionSubtitle}>调整聊天和收藏详情的阅读字号</p>
                  </div>
                </div>
                <div style={styles.readingGrid}>
                  {READING_OPTIONS.map((option) => {
                    const active = chatFontScale === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        style={{
                          ...styles.readingOption,
                          ...(active ? styles.readingOptionActive : {}),
                        }}
                        onClick={() => setChatFontScale(option.value)}
                      >
                        <span
                          style={{
                            ...styles.readingPreview,
                            fontSize: option.previewSize,
                            color: active ? 'var(--color-primary)' : 'var(--color-text)',
                          }}
                        >
                          {option.label}
                        </span>
                        <span style={styles.readingTitle}>{option.title}</span>
                        <span style={styles.readingDesc}>{option.desc}</span>
                      </button>
                    )
                  })}
                </div>
              </section>

              <section style={styles.sectionCard}>
                <div style={styles.sectionHeading}>
                  <div>
                    <h2 style={styles.sectionTitle}>账号与安全</h2>
                    <p style={styles.sectionSubtitle}>管理登录状态和敏感数据</p>
                  </div>
                </div>
                <div style={styles.settingsList}>
                  <div style={styles.settingsRowStatic}>
                    <span style={styles.settingsRowLabel}>登录手机号</span>
                    <span style={styles.settingsRowValue}>{maskPhone(authUser?.phone)}</span>
                  </div>
                  <button type="button" style={styles.settingsRow} onClick={() => setClearMedicalDataOpen(true)}>
                    <span>
                      <span style={styles.settingsRowLabel}>清空健康档案</span>
                      <span style={styles.settingsRowHint}>删除结构化档案和病历图片</span>
                    </span>
                    <span style={styles.rowChevron}>›</span>
                  </button>
                  <button type="button" style={styles.settingsRow} onClick={handleLogout}>
                    <span style={styles.settingsRowLabel}>退出账户</span>
                    <span style={styles.rowChevron}>›</span>
                  </button>
                  <button type="button" style={{ ...styles.settingsRow, ...styles.dangerRow }} onClick={() => setDeleteAccountOpen(true)}>
                    <span>
                      <span style={{ ...styles.settingsRowLabel, color: 'var(--color-error)' }}>注销账户</span>
                      <span style={styles.settingsRowHint}>永久删除账号及全部数据</span>
                    </span>
                    <span style={{ ...styles.rowChevron, color: 'var(--color-error)' }}>›</span>
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
      <ClearMedicalDataDialog
        open={clearMedicalDataOpen}
        onClose={() => setClearMedicalDataOpen(false)}
        onSuccess={() => setClearMedicalDataOpen(false)}
      />
      <DeleteAccountWizard open={deleteAccountOpen} onClose={() => setDeleteAccountOpen(false)} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    background: 'linear-gradient(180deg, #FFFDF9 0%, #FFF7F1 100%)',
    overflow: 'hidden',
  },
  scrollArea: {
    height: '100%',
    overflowY: 'auto',
    padding: 'clamp(14px, 4vw, 22px)',
    paddingTop: 'calc(clamp(14px, 4vw, 22px) + var(--safe-area-top))',
    paddingBottom: 'calc(28px + var(--safe-area-bottom))',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: 'var(--color-text-muted)',
    fontSize: 15,
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    background: 'rgba(255,255,255,0.82)',
    border: '1px solid rgba(216, 180, 160, 0.22)',
    borderRadius: 18,
    color: 'var(--color-text-secondary)',
    fontSize: 15,
    cursor: 'pointer',
    padding: '0 12px 0 8px',
    marginBottom: 18,
    boxShadow: '0 8px 24px rgba(188, 116, 88, 0.06)',
  },
  form: {
    width: 'min(100%, 430px)',
    maxWidth: 430,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  header: {
    padding: '8px 2px 4px',
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: 'var(--color-text)',
    margin: '0 0 4px',
    lineHeight: 1.2,
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
    margin: 0,
    lineHeight: 1.6,
  },
  label: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--color-text)',
    marginBottom: 8,
  },
  sectionCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: '18px 16px',
    borderRadius: 20,
    border: '1px solid rgba(216, 180, 160, 0.18)',
    background: 'rgba(255,255,255,0.78)',
    boxShadow: '0 12px 34px rgba(188, 116, 88, 0.08)',
  },
  sectionHeading: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--color-text)',
    lineHeight: 1.3,
  },
  sectionSubtitle: {
    margin: '4px 0 0',
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.45,
  },
  sectionPill: {
    maxWidth: 132,
    borderRadius: 999,
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary-dark)',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 10px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flexShrink: 0,
  },
  labelError: {
    color: 'var(--color-error)',
  },
  multiSelectWrapper: {
    position: 'relative',
  },
  multiSelectTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    minHeight: 48,
    padding: '6px 14px',
    borderRadius: 12,
    border: '1px solid rgba(216, 180, 160, 0.28)',
    background: 'rgba(255, 249, 245, 0.86)',
    fontSize: 15,
    outline: 'none',
    boxSizing: 'border-box',
    cursor: 'pointer',
  },
  singleSelectValue: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  concernPanel: {
    position: 'absolute',
    top: 56,
    left: 0,
    right: 0,
    background: 'var(--color-surface)',
    border: '1px solid rgba(216, 180, 160, 0.2)',
    borderRadius: 14,
    padding: 8,
    zIndex: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
  },
  dropdownOption: {
    width: '100%',
    minHeight: 42,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '0 12px',
    border: 'none',
    borderRadius: 10,
    background: 'transparent',
    color: 'var(--color-text)',
    fontSize: 14,
    textAlign: 'left',
    cursor: 'pointer',
  },
  dropdownOptionChecked: {
    color: 'var(--color-primary)',
    background: 'rgba(245, 140, 58, 0.06)',
  },
  input: {
    width: '100%',
    height: 48,
    padding: '0 14px',
    borderRadius: 12,
    border: '1px solid rgba(216, 180, 160, 0.28)',
    background: 'rgba(255, 249, 245, 0.86)',
    color: 'var(--color-text)',
    fontSize: 16,
    boxSizing: 'border-box',
  },
  fieldControlError: {
    border: '1px solid var(--color-error)',
    background: 'var(--color-error-bg)',
  },
  datePickerTrigger: {
    width: '100%',
    height: 48,
    padding: '0 14px',
    borderRadius: 12,
    border: '1px solid rgba(216, 180, 160, 0.28)',
    background: 'rgba(255, 249, 245, 0.86)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 15,
    cursor: 'pointer',
  },
  genderRow: {
    display: 'flex',
    gap: 12,
  },
  genderBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    border: '1px solid rgba(216, 180, 160, 0.28)',
    background: 'rgba(255, 249, 245, 0.86)',
    color: 'var(--color-text)',
    fontSize: 15,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    cursor: 'pointer',
  },
  genderBtnActive: {
    border: '1px solid var(--color-primary)',
    background: 'rgba(212, 135, 108, 0.08)',
    color: 'var(--color-primary)',
  },
  genderIcon: {
    flexShrink: 0,
  },
  error: {
    margin: 0,
    fontSize: 13,
    color: 'var(--color-error)',
  },
  primaryBtn: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(135deg, #D4876C 0%, #E4A084 100%)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryBtn: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    border: '1px solid var(--color-border)',
    background: 'rgba(255,255,255,0.68)',
    color: 'var(--color-text)',
    fontSize: 15,
    cursor: 'pointer',
  },
  readingGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 8,
  },
  readingOption: {
    minWidth: 0,
    minHeight: 108,
    borderRadius: 16,
    border: '1px solid rgba(216, 180, 160, 0.22)',
    background: 'rgba(255, 249, 245, 0.78)',
    color: 'var(--color-text)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '10px 6px',
    cursor: 'pointer',
  },
  readingOptionActive: {
    borderColor: 'rgba(212, 135, 108, 0.58)',
    background: 'var(--color-primary-bg)',
    boxShadow: '0 8px 18px rgba(188, 116, 88, 0.10)',
  },
  readingPreview: {
    fontWeight: 700,
    lineHeight: 1,
  },
  readingTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  readingDesc: {
    fontSize: 11,
    color: 'var(--color-text-muted)',
    lineHeight: 1.35,
    textAlign: 'center',
  },
  settingsList: {
    display: 'flex',
    flexDirection: 'column',
  },
  settingsRowStatic: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 4px',
    borderBottom: '1px solid rgba(216, 180, 160, 0.18)',
  },
  settingsRow: {
    width: '100%',
    minHeight: 58,
    border: 'none',
    borderBottom: '1px solid rgba(216, 180, 160, 0.18)',
    background: 'transparent',
    color: 'var(--color-text)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 4px',
    cursor: 'pointer',
    textAlign: 'left',
  },
  dangerRow: {
    borderBottom: 'none',
  },
  settingsRowLabel: {
    display: 'block',
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--color-text)',
    lineHeight: 1.4,
  },
  settingsRowHint: {
    display: 'block',
    marginTop: 2,
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.4,
  },
  settingsRowValue: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
    whiteSpace: 'nowrap',
  },
  rowChevron: {
    color: 'var(--color-text-muted)',
    fontSize: 26,
    lineHeight: 1,
    flexShrink: 0,
  },
}
