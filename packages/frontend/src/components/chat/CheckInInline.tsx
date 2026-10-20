import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CheckInA2uiSchema,
  CheckInAttachment,
  CheckInCardStatus,
  CheckInDraftToolOutput,
  CheckInRecord,
  CheckInRenderedA2uiSchema,
  CheckInValues,
} from '@health-agent/shared'
import A2uiSchemaRenderer from '../../lib/a2ui/schemaRenderer.js'
import CheckInEditableForm from '../../lib/a2ui/EditableForm.js'
import {
  cancelCheckInCard,
  commitCheckInDraft,
  getCheckInCard,
  saveCheckInCard,
} from '../../services/checkInApi.js'
import {
  setupCheckInAsyncLifecycle,
  shouldApplyCheckInCardInvalidation,
  shouldMuteCheckInReadOnlyCard,
} from './checkInInlineLifecycle.js'

type Mode = 'edit' | 'submitting' | 'done'
const CHECK_IN_CARD_INVALIDATED_EVENT = 'cx-check-in-card-invalidated'

function asDraftOutput(value: unknown): CheckInDraftToolOutput | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const action = record.action
  if (
    action !== 'draft_created'
    && action !== 'draft_for_existing'
    && action !== 'schema_candidates'
    && action !== 'schema_not_found'
  ) return null
  return value as CheckInDraftToolOutput
}

function asLegacyRenderedSchema(value: unknown): CheckInRenderedA2uiSchema | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'check_in_record' && Array.isArray(record.blocks)) {
    return value as CheckInRenderedA2uiSchema
  }
  return null
}

function buildInitialValues(values?: CheckInValues | null): CheckInValues {
  if (!values || typeof values !== 'object') return {}
  return { ...values }
}

function isInvalidatedStatus(status?: CheckInCardStatus | null): boolean {
  return status === 'invalidated' || status === 'deleted'
}

function statusLabelOf(status: CheckInCardStatus): string | null {
  if (status === 'saved') return '已保存'
  if (isInvalidatedStatus(status)) return '已失效'
  return '待保存'
}

export default function CheckInInline({
  output,
  loading = false,
  supersededByNewerUserMessage = false,
}: {
  output?: unknown
  loading?: boolean
  supersededByNewerUserMessage?: boolean
}) {
  if (loading) {
    return null
  }

  const draft = asDraftOutput(output)

  // 历史记录页面或 SSE 重放过期会话:旧 record 直接用只读 renderer
  const legacyRendered = asLegacyRenderedSchema(output)
  if (legacyRendered) {
    return (
      <div style={styles.wrap}>
        <MutedCard>
          <A2uiSchemaRenderer schema={legacyRendered} />
        </MutedCard>
      </div>
    )
  }

  if (!draft) return null

  if (draft.action === 'schema_candidates') {
    return (
      <div style={styles.notice}>
        <strong style={styles.noticeTitle}>需要确认打卡分类</strong>
        <p style={styles.noticeText}>
          {draft.candidates?.map((item) => item.categoryName).join('、') ?? draft.message}
        </p>
      </div>
    )
  }
  if (draft.action === 'schema_not_found') {
    return null
  }

  return <DraftCard draft={draft} supersededByNewerUserMessage={supersededByNewerUserMessage} />
}

function DraftCard({
  draft,
  supersededByNewerUserMessage,
}: {
  draft: CheckInDraftToolOutput
  supersededByNewerUserMessage: boolean
}) {
  const checkInCardId = draft.checkInCardId ?? null
  const draftToken = draft.draftToken ?? null
  const initialAttachments = (draft.draftAttachments ?? []) as CheckInAttachment[]
  const isSaveIntent = draft.isSave === true || (draft as { is_save?: unknown }).is_save === true

  const [mode, setMode] = useState<Mode>('edit')
  const [cardStatus, setCardStatus] = useState<CheckInCardStatus>(() => draft.status ?? 'draft')
  const [schema, setSchema] = useState<CheckInA2uiSchema | undefined>(() => draft.draftSchema as CheckInA2uiSchema | undefined)
  const [values, setValues] = useState<CheckInValues>(() => buildInitialValues(draft.draftValues))
  const [note, setNote] = useState<string>(() => {
    const renderedNote = (draft.draftRendered?.blocks ?? []).find((b) => b.type === 'note')
    return renderedNote && renderedNote.type === 'note' ? renderedNote.text : ''
  })
  const [attachments, setAttachments] = useState<CheckInAttachment[]>(initialAttachments)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [savedRecord, setSavedRecord] = useState<CheckInRecord | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const cancelledRef = useRef<boolean>(false)
  const lifecycleTimerRef = useRef<number | null>(null)
  const cardStatusRef = useRef<CheckInCardStatus>(cardStatus)

  useEffect(() => setupCheckInAsyncLifecycle(cancelledRef, lifecycleTimerRef), [])

  useEffect(() => {
    cardStatusRef.current = cardStatus
  }, [cardStatus])

  useEffect(() => {
    const supersededCardId = draft.supersedesCheckInCardId
    if (!supersededCardId) return
    window.dispatchEvent(new CustomEvent(CHECK_IN_CARD_INVALIDATED_EVENT, {
      detail: { cardId: supersededCardId },
    }))
  }, [draft.supersedesCheckInCardId])

  useEffect(() => {
    if (!checkInCardId) return
    const onInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<{ cardId?: string | null }>).detail
      if (detail?.cardId !== checkInCardId) return
      if (!shouldApplyCheckInCardInvalidation({ status: cardStatusRef.current })) return
      setCardStatus('invalidated')
      setMode('edit')
    }
    window.addEventListener(CHECK_IN_CARD_INVALIDATED_EVENT, onInvalidated)
    return () => window.removeEventListener(CHECK_IN_CARD_INVALIDATED_EVENT, onInvalidated)
  }, [checkInCardId])

  useEffect(() => {
    if (!checkInCardId) return
    let active = true
    getCheckInCard(checkInCardId)
      .then((card) => {
        if (!active || cancelledRef.current) return
        setSchema(card.schema)
        setValues(buildInitialValues(card.values))
        setNote(card.note ?? '')
        setAttachments(card.attachments)
        setCardStatus(card.status)
        if (card.record) {
          setSavedRecord(card.record)
          setMode('done')
        } else if (card.status === 'draft' && !isSaveIntent && !cancelled) {
          setMode('edit')
        }
      })
      .catch(() => {
        return
      })
    return () => {
      active = false
    }
  }, [checkInCardId, isSaveIntent, cancelled])

  const helperText = useMemo(() => {
    if (isSaveIntent || isInvalidatedStatus(cardStatus)) return undefined
    if (mode !== 'edit') return undefined
    return draft.action === 'draft_for_existing'
      ? '已基于已有分类预填本次记录;请你核对/补全后点击保存。'
      : '已为你生成新的打卡卡片;请你核对/补全后点击保存。'
  }, [mode, draft.action, isSaveIntent, cardStatus])

  const isReadOnlyMuted = shouldMuteCheckInReadOnlyCard({
    hasSavedRecord: !!savedRecord,
    isSaveIntent,
    supersededByNewerUserMessage,
    status: cardStatus,
  })

  if ((!checkInCardId && !draftToken) || !schema) {
    return (
      <div style={styles.notice}>
        <strong style={styles.noticeTitle}>打卡卡片</strong>
        <p style={styles.noticeText}>{draft.message}</p>
      </div>
    )
  }

  if (mode === 'done' && savedRecord) {
    return (
      <div style={styles.wrap}>
        <FrozenEditableCard
          schema={schema}
          values={values}
          attachments={attachments}
          note={note}
          helperText={helperText}
          statusLabel="已保存"
        />
      </div>
    )
  }

  if (isReadOnlyMuted) {
    return (
      <div style={styles.wrap}>
        {schema ? (
          <FrozenEditableCard
            schema={schema}
            values={values}
            attachments={attachments}
            note={note}
            helperText={helperText}
            statusLabel={statusLabelOf(cardStatus)}
          />
        ) : (
          <MutedCard>
            <div style={styles.notice}>
              <strong style={styles.noticeTitle}>打卡卡片草稿</strong>
              <p style={styles.noticeText}>{draft.message}</p>
            </div>
          </MutedCard>
        )}
      </div>
    )
  }

  if (cancelled) {
    return (
      <div style={styles.wrap}>
        <div style={styles.notice}>
          <strong style={styles.noticeTitle}>已取消本次打卡草稿</strong>
          <p style={styles.noticeText}>这条记录还没有保存。</p>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.wrap}>
      <CheckInEditableForm
        schema={schema}
        values={values}
        attachments={attachments}
        note={note}
        tags={[]}
        helperText={helperText}
        statusLabel={statusLabelOf(cardStatus)}
        submitting={mode === 'submitting'}
        errorMessage={errorMessage}
        onChangeValue={(key, v) => {
          setValues((prev) => ({ ...prev, [key]: v as any }))
        }}
        onChangeNote={setNote}
        onCancel={async () => {
          if (checkInCardId) {
            setErrorMessage(null)
            setMode('submitting')
            try {
              const card = await cancelCheckInCard(checkInCardId)
              if (cancelledRef.current) return
              setCardStatus(card.status)
              setMode('edit')
              window.dispatchEvent(new CustomEvent(CHECK_IN_CARD_INVALIDATED_EVENT, {
                detail: { cardId: checkInCardId },
              }))
            } catch (err: any) {
              if (cancelledRef.current) return
              setErrorMessage(err?.message ?? '取消失败,请稍后再试')
              setMode('edit')
            }
            return
          }
          setCancelled(true)
        }}
        onSubmit={async () => {
          if (mode === 'submitting') return
          setErrorMessage(null)
          setMode('submitting')
          try {
            const record = checkInCardId
              ? (await saveCheckInCard(checkInCardId, {
                  values,
                  note: note.trim() || null,
                })).record
              : await commitCheckInDraft({
                  draftToken: draftToken ?? undefined,
                  values,
                  note: note.trim() || null,
                })
            if (cancelledRef.current) return
            setCancelled(false)
            setSavedRecord(record)
            setCardStatus('saved')
            setMode('done')
          } catch (err: any) {
            if (cancelledRef.current) return
            setErrorMessage(err?.message ?? '保存失败,请稍后再试')
            setMode('edit')
          }
        }}
      />
    </div>
  )
}

function FrozenEditableCard({
  schema,
  values,
  attachments,
  note,
  helperText,
  statusLabel,
}: {
  schema: CheckInA2uiSchema
  values: CheckInValues
  attachments: CheckInAttachment[]
  note: string
  helperText?: string
  statusLabel: string | null
}) {
  return (
    <MutedCard>
      <CheckInEditableForm
        schema={schema}
        values={values}
        attachments={attachments}
        note={note}
        tags={[]}
        helperText={helperText}
        statusLabel={statusLabel}
        readOnly
        onChangeValue={() => {}}
        onChangeNote={() => {}}
        onSubmit={() => {}}
      />
    </MutedCard>
  )
}

function MutedCard({ children }: { children: React.ReactNode }) {
  return <div style={styles.mutedCard}>{children}</div>
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    margin: '10px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  loading: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    margin: '10px 0',
    padding: '8px 12px',
    borderRadius: 999,
    background: 'rgba(245, 166, 35, 0.12)',
    color: 'var(--color-primary-dark)',
    fontSize: 13,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    background: 'var(--color-primary)',
  },
  notice: {
    margin: '10px 0',
    borderRadius: 8,
    background: 'rgba(255, 250, 246, 0.92)',
    border: '1px solid rgba(184, 112, 90, 0.18)',
    padding: 12,
  },
  noticeTitle: {
    display: 'block',
    fontSize: 14,
    color: 'var(--color-text)',
    marginBottom: 4,
  },
  noticeText: {
    margin: 0,
    fontSize: 13,
    lineHeight: '20px',
    color: 'var(--color-text-muted)',
  },
  mutedCard: {
    opacity: 0.58,
    filter: 'grayscale(0.28)',
    pointerEvents: 'none',
  },
}
