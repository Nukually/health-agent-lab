/**
 * ApprovalCard — 结构化档案字段更新确认卡片
 *
 * LLM 通过 update_structured_profile 工具发起更新请求（fire-and-forget），
 * 前端展示 currentLabel → proposedLabel，用户点击同意调 /medical/profile/patch 落库，
 * 拒绝仅关闭卡片。
 */

import { useState } from 'react'
import {
  MEDICATION_DURATION_LABELS,
  SELECTABLE_MEDICATION_DURATIONS,
  formatMedicationDurationDetails,
  formatMedicationNames,
  normalizeMedicalProfileData,
  resolveMedicationDurationMap,
  resolveMedicationItems,
  type ToolApprovalPayload,
  type ApiResponse,
  type MedicalProfileData,
  type SelectableMedicationDuration,
} from '@health-agent/shared'
import { useStore } from '../../stores/index.js'
import { api } from '../../services/api.js'

interface Props {
  payload: ToolApprovalPayload
}

export default function ApprovalCard({ payload }: Props) {
  const resolveApproval = useStore((s) => s.resolveApproval)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const initialMedicationPatch = normalizeMedicalProfileData(
    payload.profilePatch ?? (
      payload.field === 'medications' && Array.isArray(payload.proposedValue)
        ? { medications: payload.proposedValue as MedicalProfileData['medications'] }
        : null
    ),
  )
  const isMedicationCard = (
    (payload.field === 'medications' || payload.field === 'medicationDuration') &&
    Boolean(initialMedicationPatch.medications?.length)
  )
  const initialMedicationItems = isMedicationCard
    ? resolveMedicationItems(initialMedicationPatch.medications, initialMedicationPatch.medicationCustom)
    : []
  const [medicationDurations, setMedicationDurations] = useState<Record<string, SelectableMedicationDuration>>(
    () => {
      if (!isMedicationCard) return {}
      const map = resolveMedicationDurationMap(initialMedicationPatch)
      for (const item of initialMedicationItems) {
        if (!map[item.key]) map[item.key] = 'within_1m'
      }
      return map
    },
  )
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const medicationItems = initialMedicationItems
  const medicationDefaultDuration = SELECTABLE_MEDICATION_DURATIONS.includes(initialMedicationPatch.medicationDuration as any)
    ? initialMedicationPatch.medicationDuration as SelectableMedicationDuration
    : medicationItems.length > 0
      ? 'within_1m'
      : undefined
  const medicationOverrideDurations: Record<string, SelectableMedicationDuration> = {}
  for (const item of medicationItems) {
    const duration = medicationDurations[item.key]
    if (duration && (!medicationDefaultDuration || duration !== medicationDefaultDuration)) {
      medicationOverrideDurations[item.key] = duration
    }
  }
  const editedMedicationPatch = isMedicationCard
    ? normalizeMedicalProfileData({
        ...initialMedicationPatch,
        ...(medicationDefaultDuration ? { medicationDuration: medicationDefaultDuration } : {}),
        medicationDurations: medicationOverrideDurations,
      })
    : undefined
  const proposedText = editedMedicationPatch
    ? formatMedicationApprovalText()
    : payload.proposedLabel

  function formatMedicationApprovalText(): string {
    if (!editedMedicationPatch) return payload.proposedLabel

    const names = formatMedicationNames(editedMedicationPatch)
    const durations = formatMedicationDurationDetails(editedMedicationPatch)
    if (durations === '无需填写') return `${names}：无需填写`

    return medicationItems
      .map((item) => {
        const duration = medicationDurations[item.key] ?? medicationDefaultDuration
        const label = duration ? MEDICATION_DURATION_LABELS[duration] || duration : '未填写'
        const prefix = duration && medicationDefaultDuration && duration === medicationDefaultDuration
          ? '使用默认：'
          : ''
        return `${item.label}：${prefix}${label}`
      })
      .join('；')
  }

  function medicationDurationOptionLabel(duration: SelectableMedicationDuration): string {
    const label = MEDICATION_DURATION_LABELS[duration]
    return duration === medicationDefaultDuration ? `使用默认：${label}` : label
  }

  function setMedicationDuration(key: string, duration: string) {
    if (!duration) return
    setMedicationDurations((prev) => ({ ...prev, [key]: duration as SelectableMedicationDuration }))
  }

  async function doPatch() {
    setSubmitting('approve')
    setError(null)
    try {
      await api.post<ApiResponse<{ field: string; value: unknown }>>(
        '/medical/profile/patch',
        {
          field: payload.field,
          value: payload.proposedValue,
          profilePatch: editedMedicationPatch ?? payload.profilePatch,
          // 传 sessionId 让后端记录 session-event（告知下一轮 LLM 已落库）
          sessionId: currentSessionId ?? undefined,
          approvalId: payload.approvalId,
          toolCallId: payload.toolCallId,
        },
      )
      resolveApproval(payload.approvalId, 'approved')
    } catch (e: any) {
      setError(e.message || '更新失败，请稍后重试')
      setSubmitting(null)
    }
  }

  function handleApprove() {
    if (submitting) return
    void doPatch()
  }

  async function handleReject() {
    if (submitting) return
    setSubmitting('reject')
    setError(null)
    // 需要把 field 登记到 session.rejected_fields，让下一轮 prompt 告知 LLM，避免重复尝试
    if (!currentSessionId) {
      setError('会话未建立，无法拒绝')
      setSubmitting(null)
      return
    }
    try {
      await api.post<ApiResponse<{ sessionId: string; field: string }>>(
        '/medical/profile/reject',
        {
          sessionId: currentSessionId,
          field: payload.field,
          approvalId: payload.approvalId,
          toolCallId: payload.toolCallId,
        },
      )
      resolveApproval(payload.approvalId, 'rejected')
    } catch (e: any) {
      setError(e.message || '拒绝失败，请稍后重试')
      setSubmitting(null)
    }
  }

  const currentText = payload.currentLabel ?? '未填写'
  const title =
    payload.field === 'currentConcern'
      ? '确认更新当前关注情况'
      : payload.storageScope === 'medical_record'
        ? `确认更新档案：${payload.fieldLabel}`
        : `确认更新信息：${payload.fieldLabel}`

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>{title}</span>
      </div>
      <div style={styles.body}>
        <div style={styles.row}>
          <span style={styles.rowLabel}>当前</span>
          <span style={styles.rowValueMuted}>{currentText}</span>
        </div>
        <div style={styles.arrow}>↓</div>
        <div style={styles.row}>
          <span style={styles.rowLabel}>更新为</span>
          <span style={styles.rowValueHighlight}>{proposedText}</span>
        </div>
        {isMedicationCard && medicationItems.length === 0 && (
          <div style={styles.medicationNotice}>用药时长：无需填写</div>
        )}
        {isMedicationCard && medicationItems.length > 0 && (
          <div style={styles.medicationEditor}>
            {medicationItems.map((item) => (
              <label key={item.key} style={styles.medicationRow}>
                <span style={styles.medicationName}>{item.label}</span>
                <select
                  value={medicationDurations[item.key] ?? 'within_1m'}
                  onChange={(event) => setMedicationDuration(item.key, event.target.value)}
                  style={styles.durationSelect}
                >
                  {SELECTABLE_MEDICATION_DURATIONS.map((duration) => (
                    <option key={duration} value={duration}>
                      {medicationDurationOptionLabel(duration)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.actions}>
        <button
          style={{ ...styles.btnReject, ...(submitting ? styles.btnDisabled : {}) }}
          onClick={handleReject}
          disabled={submitting !== null}
        >
          {submitting === 'reject' ? '拒绝中...' : '拒绝'}
        </button>
        <button
          style={{ ...styles.btnApprove, ...(submitting ? styles.btnDisabled : {}) }}
          onClick={handleApprove}
          disabled={submitting !== null}
        >
          {submitting === 'approve' ? '更新中...' : '同意'}
        </button>
      </div>
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
    gap: 4,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
  },
  rowLabel: {
    width: 52,
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  rowValueMuted: {
    color: 'var(--color-text-muted)',
  },
  rowValueHighlight: {
    color: 'var(--color-brand, #D4876C)',
    fontWeight: 500,
  },
  arrow: {
    marginLeft: 60,
    color: 'var(--color-text-muted)',
    fontSize: 12,
    lineHeight: 1,
  },
  medicationNotice: {
    marginLeft: 60,
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  medicationEditor: {
    marginTop: 8,
    padding: 10,
    borderRadius: 12,
    border: '1px solid rgba(212, 135, 108, 0.2)',
    background: 'rgba(212, 135, 108, 0.06)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  medicationRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  medicationName: {
    width: 86,
    flexShrink: 0,
    fontSize: 13,
    color: 'var(--color-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  durationSelect: {
    flex: 1,
    minWidth: 0,
    height: 34,
    borderRadius: 8,
    border: '1px solid var(--color-border)',
    background: 'rgba(255, 255, 255, 0.72)',
    color: 'var(--color-text)',
    fontSize: 13,
    padding: '0 8px',
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
  btnApprove: {
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
