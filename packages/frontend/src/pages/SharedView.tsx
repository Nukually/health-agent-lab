import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import type { MessageRecord, SharedSessionDetail } from '@health-agent/shared'
import MessageBubble from '../components/chat/MessageBubble.js'
import AssistantMessage, { collectMedicalLiteratureSources, collectMedicalRiskResources } from '../components/chat/AssistantMessage.js'
import { syncScheduledTaskCalendarsFromMessages } from '../lib/scheduledTaskCalendarSync.js'
import { formatMessageTimestamp } from '../utils/date.js'

type Status = 'loading' | 'ok' | 'error'

export default function SharedView() {
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<Status>('loading')
  const [data, setData] = useState<SharedSessionDetail | null>(null)
  const medicalRiskResources = useMemo(() => {
    const toolCalls = data?.messages.flatMap((message) => message.toolCalls ?? []) ?? []
    return collectMedicalRiskResources(toolCalls)
  }, [data])
  const medicalLiteratureSources = useMemo(() => {
    const toolCalls = data?.messages.flatMap((message) => message.toolCalls ?? []) ?? []
    return collectMedicalLiteratureSources(toolCalls)
  }, [data])

  useEffect(() => {
    if (!token) { setStatus('error'); return }

    fetch(`/api/shared/${token}`)
      .then((r) => {
        if (!r.ok) throw new Error('not found')
        return r.json()
      })
      .then((json) => {
        setData(json.data)
        syncScheduledTaskCalendarsFromMessages(json.data?.messages ?? [])
        setStatus('ok')
      })
      .catch(() => setStatus('error'))
  }, [token])

  if (status === 'loading') {
    return (
      <div style={styles.center}>
        <p style={styles.muted}>加载中...</p>
      </div>
    )
  }

  if (status === 'error' || !data) {
    return (
      <div style={styles.center}>
        <p style={styles.errorTitle}>对话不存在</p>
        <p style={styles.muted}>该分享链接无效或已取消分享</p>
      </div>
    )
  }

  let activeSyntheticDocs: NonNullable<MessageRecord['syntheticDocs']> | undefined
  let activeSyntheticCommunicationCards: NonNullable<MessageRecord['syntheticCommunicationCards']> | undefined
  const renderedMessages = data.messages.map((msg, idx) => {
    if (msg.role === 'user' && msg.synthetic) {
      if (msg.syntheticDocs?.length) {
        activeSyntheticDocs = [...(activeSyntheticDocs ?? []), ...msg.syntheticDocs]
      }
      if (msg.syntheticCommunicationCards?.length) {
        activeSyntheticCommunicationCards = [
          ...(activeSyntheticCommunicationCards ?? []),
          ...msg.syntheticCommunicationCards,
        ]
      }
      return null
    }

    if (msg.role === 'user') {
      activeSyntheticDocs = undefined
      activeSyntheticCommunicationCards = undefined
      return <MessageBubble key={msg.id} message={msg} />
    }

    if (msg.role === 'assistant') {
      const nextMsg = data.messages[idx + 1]
      const askUserQuestionAnswerText =
        nextMsg?.role === 'user' && !nextMsg.synthetic ? nextMsg.content : undefined
      return (
        <AssistantMessage
          key={msg.id}
          message={msg}
          sessionId={data.sessionId}
          askUserQuestionAnswerText={askUserQuestionAnswerText}
          videoResourceSource="shared_view"
          sharedToken={token}
          feedback={data.feedbackMap[msg.id] ?? null}
          showReadonlyFeedback
          referenceDocs={activeSyntheticDocs}
          referenceCommunicationCards={activeSyntheticCommunicationCards}
          medicalRiskResources={medicalRiskResources}
          medicalLiteratureSources={medicalLiteratureSources}
        />
      )
    }

    return null
  })

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.brand}>Health Agent Lab</h1>
        <div style={styles.headerMeta}>
          <span style={styles.title}>{data.title || '未命名对话'}</span>
          <span style={styles.badge}>分享的对话</span>
        </div>
      </div>

      {/* Messages */}
      <div style={styles.messageList}>
        {renderedMessages}
      </div>

      {/* Footer */}
      <div style={styles.footer}>
        <p style={styles.muted}>
          {data.messageCount} 条消息 · {formatMessageTimestamp(data.createdAt)}
        </p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100%',
    overflow: 'hidden',
    background: 'var(--color-bg)',
    display: 'flex',
    flexDirection: 'column',
  },
  center: {
    minHeight: 'var(--app-height)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-bg)',
    padding: 24,
  },
  header: {
    padding: '16px 16px 12px',
    paddingTop: 'calc(16px + var(--safe-area-top))',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  brand: {
    fontSize: 18,
    fontWeight: 400,
    fontFamily: 'var(--font-brand)',
    color: 'var(--color-brand)',
    margin: '0 0 8px',
  },
  headerMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--color-text)',
  },
  badge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: 'var(--color-surface, #f5f5f5)',
    color: 'var(--color-text-muted)',
    fontWeight: 500,
  },
  messageList: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 0',
  },
  footer: {
    padding: '12px 16px',
    paddingBottom: 'calc(12px + var(--safe-area-bottom))',
    borderTop: '1px solid var(--color-border)',
    textAlign: 'center',
    flexShrink: 0,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: 500,
    color: 'var(--color-text)',
    margin: '0 0 8px',
  },
  muted: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
    margin: 0,
  },
}
