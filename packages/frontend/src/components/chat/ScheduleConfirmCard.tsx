/**
 * ScheduleConfirmCard — schedule 工具 add/update/delete 的用户确认卡片
 *
 * LLM 通过 schedule 工具发起提醒操作（不落库），前端展示操作内容；
 * 用户点"确认"调 /scheduled-tasks/confirm 真正落库，点"拒绝"调 /scheduled-tasks/reject 登记。
 * 两种结果都通过 session-event 在下一轮 <system-reminder> 告知 LLM。
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ApiResponse, ScheduleConfirmationPayload } from '@health-agent/shared'
import { useStore } from '../../stores/index.js'
import { api } from '../../services/api.js'

interface Props {
  payload: ScheduleConfirmationPayload
  /** 内联到时间线节点下方时清除为底部摆放设的外边距（避让头像的 54px 左缩进） */
  inline?: boolean
}

const ACTION_TITLE: Record<ScheduleConfirmationPayload['action'], string> = {
  add: '确认设置提醒',
  update: '确认修改提醒',
  delete: '确认删除提醒',
}

const CONFIRM_LABEL: Record<ScheduleConfirmationPayload['action'], string> = {
  add: '确认设置',
  update: '确认修改',
  delete: '确认删除',
}

export default function ScheduleConfirmCard({ payload, inline = false }: Props) {
  const resolveScheduleConfirmation = useStore((s) => s.resolveScheduleConfirmation)
  const markScheduleStepInMessage = useStore((s) => s.markScheduleStepInMessage)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const [submitting, setSubmitting] = useState<'confirm' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 点击成功后：①把当前会话内存里该消息的过程节点标成终态（即时显示）②从待办队列移除
  // confirm 返回的 taskId（提醒真实 UUID）写进 step，供结果卡深链跳转详情页
  function applyResult(status: 'confirmed' | 'rejected', scheduledTaskId?: string | null) {
    if (payload.messageId) {
      markScheduleStepInMessage(payload.messageId, payload.toolCallId, status, scheduledTaskId)
    }
    resolveScheduleConfirmation(payload.confirmationId, status)
  }

  async function handleConfirm() {
    if (submitting) return
    setSubmitting('confirm')
    setError(null)
    try {
      const res = await api.post<ApiResponse<{ action: string; taskId?: string | null }>>(
        '/scheduled-tasks/confirm',
        {
          confirmationId: payload.confirmationId,
          toolCallId: payload.toolCallId,
          messageId: payload.messageId,
          sessionId: currentSessionId ?? undefined,
          pendingTask: payload.pendingTask,
        },
      )
      applyResult('confirmed', res.data?.taskId ?? null)
    } catch (e: any) {
      setError(e.message || '操作失败，请稍后重试')
      setSubmitting(null)
    }
  }

  async function handleReject() {
    if (submitting) return
    setSubmitting('reject')
    setError(null)
    try {
      await api.post<ApiResponse<{ action: string }>>(
        '/scheduled-tasks/reject',
        {
          confirmationId: payload.confirmationId,
          toolCallId: payload.toolCallId,
          messageId: payload.messageId,
          sessionId: currentSessionId ?? undefined,
          action: payload.action,
          taskName: payload.taskName ?? undefined,
        },
      )
      applyResult('rejected')
    } catch (e: any) {
      setError(e.message || '操作失败，请稍后重试')
      setSubmitting(null)
    }
  }

  return (
    <div style={inline ? { ...styles.card, ...styles.cardInline } : styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>{ACTION_TITLE[payload.action]}</span>
      </div>
      <div style={styles.body}>
        {payload.taskName && (
          <div style={styles.row}>
            <span style={styles.rowLabel}>提醒</span>
            <span style={styles.rowValueHighlight}>{payload.taskName}</span>
          </div>
        )}
        {payload.action !== 'delete' && payload.dueAtLabel && (
          <div style={styles.row}>
            <span style={styles.rowLabel}>时间</span>
            <span style={styles.rowValue}>{payload.dueAtLabel}</span>
          </div>
        )}
        {payload.action !== 'delete' && payload.scheduleSummary && (
          <div style={styles.row}>
            <span style={styles.rowLabel}>频率</span>
            <span style={styles.rowValueMuted}>{payload.scheduleSummary}</span>
          </div>
        )}
        {payload.action !== 'delete' && payload.message && (
          <div style={styles.row}>
            <span style={styles.rowLabel}>内容</span>
            <span style={styles.rowValueMuted}>{payload.message}</span>
          </div>
        )}
        {payload.action === 'delete' && (
          <div style={styles.deleteNotice}>删除后该提醒不再触发。</div>
        )}
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.actions}>
        <button
          style={{ ...styles.btnReject, ...(submitting ? styles.btnDisabled : {}) }}
          onClick={handleReject}
          disabled={submitting !== null}
        >
          {submitting === 'reject' ? '处理中...' : '拒绝'}
        </button>
        <button
          style={{ ...styles.btnConfirm, ...(submitting ? styles.btnDisabled : {}) }}
          onClick={handleConfirm}
          disabled={submitting !== null}
        >
          {submitting === 'confirm' ? '处理中...' : CONFIRM_LABEL[payload.action]}
        </button>
      </div>
    </div>
  )
}

const RESULT_TITLE: Record<ScheduleConfirmationPayload['action'], { confirmed: string; rejected: string }> = {
  add: { confirmed: '已设置提醒', rejected: '已拒绝设置提醒' },
  update: { confirmed: '已修改提醒', rejected: '已拒绝修改提醒' },
  delete: { confirmed: '已删除提醒', rejected: '已拒绝删除提醒' },
}

interface ResultProps {
  action: ScheduleConfirmationPayload['action']
  status: 'confirmed' | 'rejected'
  taskName?: string | null
  dueAtLabel?: string | null
  /** 内联到时间线节点下方时清除为底部摆放设的外边距 */
  inline?: boolean
  /** 提醒真实 UUID；存在时整卡可点击跳转到该提醒详情页 */
  taskId?: string | null
  /** 分享页等场景禁用跳转（提醒不属于浏览者，跳过去查不到） */
  disableNavigation?: boolean
}

/**
 * ScheduleResultCard — schedule 确认卡的只读终态。
 * 用户点确认/拒绝后、以及历史页/分享页重放时展示，替代交互卡，保留可见的结果痕迹。
 * 确认成功且非删除、带 taskId、非分享页时整卡可点击跳到提醒详情页。
 */
export function ScheduleResultCard({ action, status, taskName, dueAtLabel, inline = false, taskId, disableNavigation = false }: ResultProps) {
  const navigate = useNavigate()
  const confirmed = status === 'confirmed'
  const canNavigate = confirmed && action !== 'delete' && !!taskId && !disableNavigation

  function handleClick() {
    if (!canNavigate || !taskId) return
    navigate(`/scheduled-tasks/${taskId}`)
  }

  return (
    <div
      style={{
        ...(inline ? { ...styles.card, ...styles.cardInline, ...styles.resultCard } : { ...styles.card, ...styles.resultCard }),
        ...(canNavigate ? styles.resultCardClickable : null),
      }}
      onClick={canNavigate ? handleClick : undefined}
      role={canNavigate ? 'button' : undefined}
      tabIndex={canNavigate ? 0 : undefined}
      onKeyDown={canNavigate ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() } } : undefined}
    >
      <div style={styles.header}>
        <span style={{ ...styles.resultBadge, ...(confirmed ? styles.resultBadgeOk : styles.resultBadgeNo) }}>
          {confirmed ? '✓' : '✕'}
        </span>
        <span style={styles.title}>{RESULT_TITLE[action][status]}</span>
      </div>
      {(taskName || (action !== 'delete' && dueAtLabel)) && (
        <div style={styles.body}>
          {taskName && (
            <div style={styles.row}>
              <span style={styles.rowLabel}>提醒</span>
              <span style={styles.rowValueHighlight}>{taskName}</span>
            </div>
          )}
          {action !== 'delete' && dueAtLabel && (
            <div style={styles.row}>
              <span style={styles.rowLabel}>时间</span>
              <span style={styles.rowValue}>{dueAtLabel}</span>
            </div>
          )}
        </div>
      )}
      {canNavigate && (
        <div style={styles.detailHint}>
          <span>查看详情</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 14,
    margin: '8px 16px 8px 54px',
    background: 'rgba(255, 255, 255, 0.55)',
    backdropFilter: 'blur(20px) saturate(160%)',
    WebkitBackdropFilter: 'blur(20px) saturate(160%)',
    border: '1px solid rgba(255, 255, 255, 0.6)',
    borderRadius: 16,
    boxShadow: '0 6px 24px rgba(212, 135, 108, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04)',
    animation: 'fadeIn 0.25s ease',
  },
  cardInline: {
    margin: 0,
  },
  resultCard: {
    gap: 10,
    background: 'rgba(255, 255, 255, 0.45)',
  },
  resultCardClickable: {
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  detailHint: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: -2,
    color: 'var(--color-primary, #C77A5F)',
    fontSize: 12,
    fontWeight: 600,
  },
  resultBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    lineHeight: 1,
    fontWeight: 800,
    marginRight: 8,
    flexShrink: 0,
  },
  resultBadgeOk: {
    background: 'rgba(76, 175, 122, 0.16)',
    color: '#3F9E6B',
  },
  resultBadgeNo: {
    background: 'rgba(229, 72, 72, 0.12)',
    color: '#E54848',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    fontSize: 14,
  },
  rowLabel: {
    width: 40,
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  rowValue: {
    color: 'var(--color-text)',
  },
  rowValueMuted: {
    color: 'var(--color-text-muted)',
    flex: 1,
    minWidth: 0,
    wordBreak: 'break-word',
  },
  rowValueHighlight: {
    color: 'var(--color-brand, #D4876C)',
    fontWeight: 500,
  },
  deleteNotice: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  error: {
    fontSize: 12,
    color: '#E54848',
  },
  actions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  },
  btnReject: {
    padding: '7px 16px',
    borderRadius: 10,
    background: 'transparent',
    border: '1px solid var(--color-border)',
    color: 'var(--color-text-muted)',
    fontSize: 13,
    cursor: 'pointer',
  },
  btnConfirm: {
    padding: '7px 16px',
    borderRadius: 10,
    background: 'var(--color-brand, #D4876C)',
    border: 'none',
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
}
