/**
 * ErrorMessage — 错误消息独立卡片
 *
 * 根据 errorCode 渲染：可爱文案 + 内联 SVG 图标 + 重试按钮
 * 与普通 assistant 气泡视觉上明显区分
 */

import type { ReactElement } from 'react'
import { ERROR_CODES, type ErrorCode } from '@health-agent/shared'

interface Props {
  errorCode?: string
  onRetry?: () => void
  canRetry?: boolean
}

interface ErrorConfig {
  title: string
  hint: string
  Icon: () => ReactElement
}

// ─── 可爱 SVG 图标 ───

function BusyIcon() {
  // 三个小人簇拥
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="22" fill="#FFF3E0" />
      <circle cx="16" cy="20" r="4" fill="#FB923C" />
      <circle cx="24" cy="18" r="4.5" fill="#F97316" />
      <circle cx="32" cy="20" r="4" fill="#FB923C" />
      <path d="M10 34 Q16 28 16 30 Q22 28 24 30 Q26 28 32 30 Q32 28 38 34 L38 38 L10 38 Z" fill="#FDBA74" />
    </svg>
  )
}

function BatteryIcon() {
  // 没电的橙子
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="26" r="18" fill="#FFE4C4" />
      <circle cx="24" cy="26" r="15" fill="#FFF5EE" />
      <path d="M22 8 Q24 4 26 8 L25 12 L23 12 Z" fill="#84CC16" />
      <circle cx="19" cy="25" r="1.5" fill="#64748B" />
      <circle cx="29" cy="25" r="1.5" fill="#64748B" />
      <path d="M20 32 Q24 29 28 32" stroke="#64748B" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function SleepIcon() {
  // 打盹的橙子
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="26" r="18" fill="#FDBA74" />
      <circle cx="24" cy="26" r="15" fill="#FFF5EE" />
      <path d="M22 8 Q24 4 26 8 L25 12 L23 12 Z" fill="#84CC16" />
      <path d="M16 25 Q18 23 20 25" stroke="#64748B" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M28 25 Q30 23 32 25" stroke="#64748B" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <ellipse cx="24" cy="33" rx="2" ry="1" fill="#64748B" />
      <text x="34" y="14" fontSize="10" fill="#94A3B8" fontWeight="bold">z</text>
      <text x="38" y="10" fontSize="7" fill="#CBD5E1" fontWeight="bold">z</text>
    </svg>
  )
}

function WifiOffIcon() {
  // 断网
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="22" fill="#FEE2E2" />
      <path d="M14 22 Q24 14 34 22" stroke="#F87171" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.4" />
      <path d="M17 26 Q24 20 31 26" stroke="#F87171" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.6" />
      <path d="M20 30 Q24 26 28 30" stroke="#F87171" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="24" cy="34" r="1.8" fill="#F87171" />
      <line x1="12" y1="12" x2="36" y2="36" stroke="#EF4444" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function HeartIcon() {
  // 慢一点
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="22" fill="#FCE7F3" />
      <path d="M24 34 L14 24 Q10 20 14 16 Q18 12 24 18 Q30 12 34 16 Q38 20 34 24 Z" fill="#F472B6" />
      <path d="M20 22 L22 22 L24 19 L26 25 L28 22 L30 22" stroke="#FFF" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PawIcon() {
  // 通用小状况
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="22" fill="#FEF3C7" />
      <ellipse cx="24" cy="30" rx="7" ry="6" fill="#FB923C" />
      <ellipse cx="16" cy="20" rx="3" ry="4" fill="#FB923C" />
      <ellipse cx="32" cy="20" rx="3" ry="4" fill="#FB923C" />
      <ellipse cx="19" cy="13" rx="2.5" ry="3" fill="#FB923C" />
      <ellipse cx="29" cy="13" rx="2.5" ry="3" fill="#FB923C" />
    </svg>
  )
}

// ─── code → 文案 + 图标映射 ───

const ERROR_CONFIG: Record<ErrorCode, ErrorConfig> = {
  [ERROR_CODES.RATE_LIMITED]: {
    title: '咨询的小伙伴有点多呢',
    hint: '请稍等几秒再试试吧 ~',
    Icon: BusyIcon,
  },
  [ERROR_CODES.QUOTA_EXCEEDED]: {
    title: '小助手今日的能量用完啦',
    hint: '我们正在补充中，请稍后再来 ~',
    Icon: BatteryIcon,
  },
  [ERROR_CODES.SERVICE_UNAVAILABLE]: {
    title: '小助手打了个盹儿',
    hint: '马上就醒来，请稍后重试 ~',
    Icon: SleepIcon,
  },
  [ERROR_CODES.NETWORK_ERROR]: {
    title: '网络好像走丢了',
    hint: '请检查网络后再试一次 ~',
    Icon: WifiOffIcon,
  },
  [ERROR_CODES.LLM_STREAM_TIMEOUT]: {
    title: '小助手刚刚卡住了',
    hint: '请稍后再试一次 ~',
    Icon: SleepIcon,
  },
  [ERROR_CODES.USER_RATE_LIMITED]: {
    title: '消息发得有点快哦',
    hint: '深呼吸一下再聊吧 ~',
    Icon: HeartIcon,
  },
  [ERROR_CODES.CONTEXT_TOO_LONG]: {
    title: '对话有点太长啦',
    hint: '小助手整理了一下，再试一次就好 ~',
    Icon: PawIcon,
  },
  [ERROR_CODES.OUTPUT_TRUNCATED]: {
    title: '回答有点长被截断了',
    hint: '追问一句让我继续说 ~',
    Icon: PawIcon,
  },
  [ERROR_CODES.UNKNOWN_ERROR]: {
    title: '小助手遇到了点小状况',
    hint: '请稍后重试 ~',
    Icon: PawIcon,
  },
}

function getConfig(code?: string): ErrorConfig {
  if (code && code in ERROR_CONFIG) {
    return ERROR_CONFIG[code as ErrorCode]
  }
  return ERROR_CONFIG[ERROR_CODES.UNKNOWN_ERROR]
}

export default function ErrorMessage({ errorCode, onRetry, canRetry = true }: Props) {
  const { title, hint, Icon } = getConfig(errorCode)

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        <div style={styles.iconWrap}>
          <Icon />
        </div>
        <div style={styles.textWrap}>
          <div style={styles.title}>{title}</div>
          <div style={styles.hint}>{hint}</div>
        </div>
        {canRetry && onRetry && (
          <button style={styles.retryBtn} onClick={onRetry} type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
            <span>重试</span>
          </button>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    padding: '8px 12px',
    display: 'flex',
    justifyContent: 'flex-start',
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'linear-gradient(135deg, #FFF7ED 0%, #FFEDD5 100%)',
    border: '1px solid rgba(251, 146, 60, 0.2)',
    borderRadius: 16,
    maxWidth: 360,
    boxShadow: '0 2px 8px rgba(251, 146, 60, 0.08)',
  },
  iconWrap: {
    flexShrink: 0,
    width: 48,
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: 500,
    color: '#9A3412',
    lineHeight: 1.4,
  },
  hint: {
    fontSize: 12,
    color: '#C2410C',
    marginTop: 2,
    lineHeight: 1.4,
    opacity: 0.8,
  },
  retryBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 500,
    color: '#F97316',
    background: 'rgba(255, 255, 255, 0.8)',
    border: '1px solid rgba(251, 146, 60, 0.3)',
    borderRadius: 999,
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all 0.15s',
  },
}
