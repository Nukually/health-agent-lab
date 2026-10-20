/**
 * MessageBubble — 用户消息气泡（右对齐）
 *
 * 仅处理 role=user 的消息渲染。
 * Assistant 消息由 AssistantMessage 组件处理。
 */

import { useState } from 'react'
import { type MessageRecord } from '@health-agent/shared'
import { copyText } from '../../utils/clipboard.js'
import { stripRefIdAnnotation } from '../../utils/text.js'
import { formatMessageTimestamp } from '../../utils/date.js'
import ImageLightbox from '../ImageLightbox.js'
import PrivacyProtectedImage from '../PrivacyProtectedImage.js'
import { useStore } from '../../stores/index.js'

interface Props {
  message: MessageRecord
  /** 点击编辑：把该消息回填到输入框并丢弃其后历史（由 Chat 处理） */
  onEditMessage?: (message: MessageRecord) => void
}

export default function MessageBubble({
  message,
  onEditMessage,
}: Props) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  // 触屏端点击气泡才展开操作按钮（桌面端走 hover，由 CSS 控制）
  const [actionsOpen, setActionsOpen] = useState(false)
  const privacyProtected = useStore((s) => !!s.privacyProtectedImageMessageIds[message.id])

  const displayContent = stripRefIdAnnotation(message.content)
  const imageThumbs = message.images?.length
    ? message.images
    : message.imageAttachments?.map((image) => image.thumbUrl)
  const lightboxImages = message.imageAttachments?.length
    ? message.imageAttachments.map((image) => image.displayUrl ?? image.thumbUrl)
    : imageThumbs
  const downloadImages = message.imageAttachments?.map((image) =>
    image.originalUrl ?? image.displayUrl ?? image.thumbUrl
  )
  const canCopy = message.content.trim().length > 0
  const hasImages = !!imageThumbs?.length
  const hasTextBubble = !!message.content
  const hasActions = canCopy || !!onEditMessage

  function toggleActions() {
    if (!hasActions) return
    setActionsOpen((v) => !v)
  }

  async function handleCopy() {
    if (!canCopy) return
    const ok = await copyText(displayContent)
    if (!ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <>
      <div
        className={actionsOpen ? 'message-user-row actions-open' : 'message-user-row'}
        style={styles.row}
      >
        <div style={styles.bubbleCol}>
          {hasImages ? (
            <div
              onClick={toggleActions}
              style={{
                ...styles.imageGrid,
                ...(hasTextBubble ? styles.imageGridWithText : {}),
              }}
            >
              {imageThumbs?.map((src, i) => (
                <PrivacyProtectedImage
                  key={i}
                  src={src}
                  alt={`上传图片 ${i + 1}`}
                  imageStyle={{
                    ...styles.messageImage,
                    ...(privacyProtected ? styles.privacyMessageImage : {}),
                  }}
                  wrapperStyle={{
                    ...styles.messageImageWrap,
                    ...(privacyProtected ? styles.privacyMessageImageWrap : {}),
                  }}
                  badgeStyle={styles.messageImageBadge}
                  privacyProtected={privacyProtected}
                  onClick={() => setLightboxIndex(i)}
                />
              ))}
            </div>
          ) : null}

          {hasTextBubble ? (
            <div style={styles.bubble} onClick={toggleActions}>
              <div style={styles.text}>{displayContent}</div>
            </div>
          ) : null}

          {message.createdAt && (
            <span style={styles.timestamp}>{formatMessageTimestamp(message.createdAt)}</span>
          )}

          {(canCopy || onEditMessage) && (
            <div className="message-user-actions">
              {canCopy && (
                <button
                  type="button"
                  style={styles.actionIconBtn}
                  onClick={handleCopy}
                  title={copied ? '已复制' : '复制文本'}
                  aria-label={copied ? '已复制' : '复制文本'}
                >
                  {copied ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              )}
              {onEditMessage && (
                <button
                  type="button"
                  style={styles.actionIconBtn}
                  onClick={() => onEditMessage(message)}
                  title="编辑"
                  aria-label="编辑"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {lightboxIndex !== null && lightboxImages?.length ? (
        <ImageLightbox
          images={lightboxImages}
          downloadImages={downloadImages}
          initialIndex={lightboxIndex}
          privacyProtected={privacyProtected}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '6px var(--chat-content-padding-right, var(--chat-horizontal-padding, 16px)) 6px var(--chat-content-padding-left, var(--chat-horizontal-padding, 16px))',
    maxWidth: '100%',
    animation: 'fadeIn 0.2s ease',
  },
  bubbleCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    maxWidth: 'var(--chat-user-bubble-max-width, 78%)',
  },
  bubble: {
    width: 'fit-content',
    maxWidth: '100%',
    padding: '10px 14px',
    borderRadius: 16,
    borderTopRightRadius: 4,
    background: 'var(--color-user-bubble)',
    color: '#fff',
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.65,
    wordBreak: 'break-word',
    transition: 'all 0.2s',
  },
  text: {
    whiteSpace: 'pre-wrap',
  },
  imageGrid: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
    justifyContent: 'flex-end',
  },
  imageGridWithText: {
    marginBottom: 6,
  },
  messageImage: {
    maxWidth: '100%',
    maxHeight: 200,
    borderRadius: 12,
    objectFit: 'cover' as const,
    cursor: 'pointer',
  },
  messageImageWrap: {
    borderRadius: 12,
  },
  privacyMessageImage: {
    width: '100%',
    height: '100%',
    objectPosition: 'top center',
  },
  privacyMessageImageWrap: {
    width: 160,
    height: 200,
    maxWidth: '100%',
  },
  messageImageBadge: {
    top: 6,
    right: 6,
    transform: 'scale(0.9)',
    transformOrigin: 'top right',
  },
  actionIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-muted)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'color 0.15s ease, background 0.15s ease',
    padding: 0,
    WebkitTouchCallout: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  timestamp: {
    fontSize: 11,
    color: 'var(--color-text-muted)',
    marginTop: 4,
    paddingRight: 4,
    textAlign: 'right',
  },
}
