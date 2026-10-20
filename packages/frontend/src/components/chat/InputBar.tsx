import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react'
import {
  MAX_MESSAGE_LENGTH,
  MESSAGE_LENGTH_WARNING_THRESHOLD,
  type ApiResponse,
  type ImageAssetUploadResponse,
  type MessageImageAttachment,
} from '@health-agent/shared'
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder.js'
import { api } from '../../services/api.js'

interface Props {
  onSend: (
    text: string,
    images?: string[],
    imageAssetIds?: string[],
    imageAttachments?: MessageImageAttachment[],
  ) => void
  disabled?: boolean
  /** 流式输出中：textarea/加号仍可用，发送按钮换为"停止"按钮，语音按钮禁用 */
  isStreaming?: boolean
  onStop?: () => void
}

/** 编辑用户消息时回填输入框：把文本和图片塞回当前输入框并聚焦 */
export interface InputBarHandle {
  prefill: (payload: { text: string; attachments?: MessageImageAttachment[] }) => void
}

const MAX_IMAGES = 5
const MAX_IMAGE_SIZE = 12 * 1024 * 1024
const waitForPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

type UploadingImage = {
  uploadId: string
  previewUrl: string
  status: 'uploading'
}
type UploadedImage = MessageImageAttachment & {
  uploadId: string
  previewUrl: string
  status: 'ready'
}
type SelectedImage = UploadingImage | UploadedImage

function isUploadedImage(image: SelectedImage): image is UploadedImage {
  return image.status === 'ready'
}

function shouldSoftKeyboardEnterInsertNewline(): boolean {
  const nativePlatform = typeof window !== 'undefined'
    ? window.__CXNativeBridge__?.info?.platform?.toLowerCase()
    : undefined
  if (nativePlatform === 'ios' || nativePlatform === 'android' || nativePlatform === 'harmony') return true

  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  return /Android|HarmonyOS|OpenHarmony|ArkWeb|iPad|iPhone|iPod/i.test(ua)
    || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function shouldRefocusAfterSend(): boolean {
  const nativePlatform = typeof window !== 'undefined'
    ? window.__CXNativeBridge__?.info?.platform?.toLowerCase()
    : undefined
  if (nativePlatform === 'ios') return false

  if (typeof navigator === 'undefined') return true
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  if (/iPad|iPhone|iPod/i.test(ua)) return false
  if (platform === 'MacIntel' && navigator.maxTouchPoints > 1) return false
  return true
}

const InputBar = forwardRef<InputBarHandle, Props>(function InputBar({ onSend, disabled, isStreaming, onStop }, ref) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<SelectedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isProcessingImages, setIsProcessingImages] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRowRef = useRef<HTMLDivElement>(null)
  const isProcessingImagesRef = useRef(false)
  const objectUrlsRef = useRef<Set<string>>(new Set())

  const revokePreviewUrl = useCallback((url: string) => {
    if (!url.startsWith('blob:')) return
    URL.revokeObjectURL(url)
    objectUrlsRef.current.delete(url)
  }, [])

  const toAttachment = useCallback((image: UploadedImage): MessageImageAttachment => {
    return {
      assetId: image.assetId,
      thumbUrl: image.thumbUrl,
      displayUrl: image.displayUrl,
      originalUrl: image.originalUrl,
      width: image.width,
      height: image.height,
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
      objectUrlsRef.current.clear()
    }
  }, [])

  const showError = useCallback((message: string) => {
    setError(message)
    window.setTimeout(() => setError(null), 3000)
  }, [])

  const {
    startRecording,
    stopRecording,
    isRecording,
    isSupported,
    unsupportedReason,
    durationSeconds,
    partialText,
  } = useVoiceRecorder({
    onTranscription: (t) => setText((prev) => prev + t),
    onError: showError,
  })

  const partialRef = useRef(partialText)
  partialRef.current = partialText

  // 停止录音并把当前 partial 合并进 text（后续 final 丢弃）
  const flushAndStop = useCallback(() => {
    if (!isRecording) return
    const p = partialRef.current
    if (p) setText((prev) => prev + p)
    stopRecording({ discardPartial: true })
  }, [isRecording, stopRecording])

  const displayValue = isRecording ? text + partialText : text

  // textarea 自适应高度
  const adjustHeight = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [])

  useEffect(() => {
    adjustHeight()
  }, [displayValue, adjustHeight])

  // 编辑用户消息：把文本+图片回填到输入框（覆盖当前草稿），聚焦
  useImperativeHandle(ref, () => ({
    prefill: ({ text: nextText, attachments }) => {
      if (isRecording) stopRecording({ discardPartial: true })
      setText(nextText)
      const rebuilt: UploadedImage[] = (attachments ?? []).map((att, i) => ({
        ...att,
        uploadId: `prefill-${att.assetId}-${i}`,
        previewUrl: att.displayUrl ?? att.thumbUrl,
        status: 'ready' as const,
      }))
      setImages((prev) => {
        for (const image of prev) revokePreviewUrl(image.previewUrl)
        return rebuilt
      })
      requestAnimationFrame(() => {
        adjustHeight()
        inputRef.current?.focus()
      })
    },
  }), [isRecording, stopRecording, revokePreviewUrl, adjustHeight])

  // 录音中 partial 流入 → textarea 滚到底部
  useEffect(() => {
    if (isRecording && inputRef.current) {
      inputRef.current.scrollTop = inputRef.current.scrollHeight
    }
  }, [isRecording, partialText])

  // 把自身实时高度和半个输入框高度暴露给全局 CSS 变量，供 MessageList 预留空间和 FAB 定位
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const root = document.documentElement
    const sync = () => {
      root.style.setProperty('--input-bar-height', `${el.offsetHeight}px`)
      root.style.setProperty('--input-bar-lift', `${Math.round((inputRowRef.current?.offsetHeight ?? el.offsetHeight) / 2)}px`)
    }
    sync()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync)
      const timer = window.setTimeout(sync, 0)
      return () => {
        window.clearTimeout(timer)
        window.removeEventListener('resize', sync)
        root.style.removeProperty('--input-bar-height')
        root.style.removeProperty('--input-bar-lift')
      }
    }
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    if (inputRowRef.current) ro.observe(inputRowRef.current)
    return () => {
      ro.disconnect()
      root.style.removeProperty('--input-bar-height')
      root.style.removeProperty('--input-bar-lift')
    }
  }, [])

  const hasContent = !!displayValue.trim() || images.length > 0
  const charCount = displayValue.length
  const isOverLimit = charCount > MAX_MESSAGE_LENGTH
  const showCounter = charCount >= MESSAGE_LENGTH_WARNING_THRESHOLD
  const inputGlyphSize = 'var(--chat-input-glyph-size, 20px)'
  const inputGlyphStyle: React.CSSProperties = {
    width: inputGlyphSize,
    height: inputGlyphSize,
    display: 'block',
    flexShrink: 0,
  }
  const inputStopGlyphStyle: React.CSSProperties = {
    width: 'var(--chat-input-stop-glyph-size, 14px)',
    height: 'var(--chat-input-stop-glyph-size, 14px)',
    display: 'block',
    flexShrink: 0,
  }

  function handleSend() {
    if (isStreaming || isProcessingImagesRef.current) return
    // 录音中点发送：先把 partial 合进 text，再以当前合并值发送
    const merged = isRecording ? text + partialRef.current : text
    flushAndStop()
    const trimmed = merged.trim()
    if ((!trimmed && images.length === 0) || disabled || trimmed.length > MAX_MESSAGE_LENGTH) return
    const imageAttachments = images.filter(isUploadedImage).map(toAttachment)
    onSend(
      trimmed || '',
      imageAttachments.length > 0 ? imageAttachments.map((image) => image.thumbUrl) : undefined,
      imageAttachments.length > 0 ? imageAttachments.map((image) => image.assetId) : undefined,
      imageAttachments.length > 0 ? imageAttachments : undefined,
    )
    setText('')
    for (const image of images) revokePreviewUrl(image.previewUrl)
    setImages([])
    if (shouldRefocusAfterSend()) {
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      inputRef.current?.blur()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // iOS/Android/Harmony soft keyboard's "换行/return" emits Enter on textarea. Keep it as
    // a real newline there; users can still send via the explicit send button.
    if (shouldSoftKeyboardEnterInsertNewline()) return

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    // 用户开始打字/IME → 停止录音，partial 合进 text
    if (isRecording) {
      const nextValue = e.target.value
      const baseline = text + partialRef.current
      // 根据用户输入相对合并基线的差量应用到 text
      // 简单起见：直接把 nextValue 作为新 text（用户编辑替代了 partial）
      flushAndStop()
      setText(nextValue)
      return
    }
    setText(e.target.value)
  }

  function handleTextareaInteract() {
    if (isRecording) flushAndStop()
  }

  const appendImages = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    if (isProcessingImagesRef.current) {
      showError('图片正在处理，请稍候')
      return
    }

    const remaining = MAX_IMAGES - images.length
    if (remaining <= 0) {
      showError(`最多上传 ${MAX_IMAGES} 张图片`)
      return
    }

    isProcessingImagesRef.current = true
    setIsProcessingImages(true)
    await waitForPaint()

    try {
      for (const file of files.slice(0, remaining)) {
        if (file.size > MAX_IMAGE_SIZE) {
          showError('单张图片不能超过 12MB')
          continue
        }
        const previewUrl = URL.createObjectURL(file)
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        objectUrlsRef.current.add(previewUrl)
        setImages((prev) => [...prev, { uploadId, previewUrl, status: 'uploading' }])
        try {
          const form = new FormData()
          form.append('images', file)
          form.append('purpose', 'chat')
          const res = await api.postForm<ApiResponse<ImageAssetUploadResponse>>('/images/upload', form)
          const asset = res.data?.assets?.[0]
          if (!asset) throw new Error('图片上传失败，请稍后重试')
          setImages((prev) => prev.map((image) => image.uploadId === uploadId
            ? { ...asset, uploadId, previewUrl, status: 'ready' }
            : image))
        } catch (err) {
          setImages((prev) => prev.filter((image) => image.uploadId !== uploadId))
          revokePreviewUrl(previewUrl)
          showError(
            err instanceof Error
              ? err.message
              : '不支持的图片格式（如 HEIC/TIFF），请转为 JPG/PNG 后重试',
          )
        }
      }
    } finally {
      isProcessingImagesRef.current = false
      setIsProcessingImages(false)
    }
  }, [images.length, revokePreviewUrl, showError])

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // reset so same file can be re-selected
    await appendImages(files)
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file)

    if (files.length === 0) return
    e.preventDefault()
    if (isRecording) flushAndStop()
    void appendImages(files)
  }

  function removeImage(index: number) {
    setImages((prev) => {
      const target = prev[index]
      if (target) revokePreviewUrl(target.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

  function handleMicToggle() {
    if (disabled || isStreaming) return
    if (isRecording) {
      flushAndStop()
      return
    }
    if (!isSupported) {
      showError(unsupportedReason || '您的浏览器不支持录音功能')
      return
    }
    startRecording()
    // 录音开始同时聚焦输入框，在手机上会唤起软键盘，用户可随时打字覆盖
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div ref={containerRef} style={styles.container}>
      {/* 补底遮罩：从输入框下沿一直延伸到屏幕真实底部，盖住悬浮间隙（lift）那段缝，
          避免聊天最后几行文字从输入框下方漏出（豆包式：文字滚到输入框附近即被柔和遮住） */}
      <div style={styles.bottomShade} aria-hidden />

      {/* Error toast */}
      {error && <div style={styles.errorToast}>{error}</div>}

      {/* Image previews */}
      {images.length > 0 && (
        <div style={styles.previewRow}>
          {images.map((image, i) => (
            <div key={image.uploadId} style={styles.previewItem}>
              <img
                src={image.previewUrl}
                alt={`预览 ${i + 1}`}
                style={{
                  ...styles.previewImg,
                  ...(image.status === 'uploading' ? styles.previewImgUploading : {}),
                }}
              />
              {image.status === 'uploading' ? (
                <div style={styles.previewUploadingOverlay} aria-label="正在处理图片">
                  <span style={styles.previewSpinner} />
                </div>
              ) : (
                <button style={styles.previewRemove} onClick={() => removeImage(i)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Character counter */}
      {showCounter && (
        <div style={{
          ...styles.charCounter,
          color: isOverLimit ? 'var(--color-error)' : 'var(--color-text-muted)',
        }}>
          {charCount} / {MAX_MESSAGE_LENGTH}
          {isOverLimit && <span> 文本过长，请缩短后再发送</span>}
        </div>
      )}

      {/* Input row */}
      <div ref={inputRowRef} style={styles.inputRow}>
        {/* Plus button — image picker */}
        <button
          style={styles.plusBtn}
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isProcessingImages || images.length >= MAX_IMAGES}
          title="上传图片"
        >
          <svg width="20" height="20" style={inputGlyphStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleImageSelect}
        />

        {/* Textarea —— 录音中仍可编辑，onChange/onClick 会自动停录 */}
        <textarea
          ref={inputRef}
          style={styles.textarea}
          placeholder={isRecording ? '正在听您说...' : '输入您的问题...'}
          value={displayValue}
          onChange={handleTextareaChange}
          onClick={handleTextareaInteract}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          enterKeyHint="enter"
          onFocus={() => {
            // 兜底：若上一轮剪贴板复制遗留了锚在脱离文档节点上的 selection，
            // 聚焦输入框时主动清掉，防止 iOS 系统选区层拦截后续 tap。
            try {
              const sel = window.getSelection()
              if (!sel || sel.rangeCount === 0) return
              const anchor = sel.anchorNode
              if (!anchor || !document.contains(anchor) || anchor !== inputRef.current) {
                sel.removeAllRanges()
              }
            } catch { /* noop */ }
          }}
          disabled={disabled}
          rows={1}
        />

        {/* 录音中内嵌的「停止」icon（textarea 右侧） */}
        {isRecording && (
          <button
            style={styles.inlineMicBtn}
            onClick={flushAndStop}
            title={`停止录音 ${durationSeconds}s`}
            aria-label="停止录音"
          >
            <span style={styles.inlineMicDot} />
          </button>
        )}

        {/* 按钮优先级：Streaming → Send(有内容) → Mic */}
        {isStreaming ? (
          <button
            style={{ ...styles.actionBtn, ...styles.stopBtn }}
            onClick={() => onStop?.()}
            title="停止生成"
            aria-label="停止生成"
          >
            <svg width="14" height="14" style={inputStopGlyphStyle} viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
        ) : hasContent ? (
          <button
            style={{
              ...styles.actionBtn,
              ...styles.sendBtn,
              ...(isOverLimit ? { opacity: 0.5 } : {}),
            }}
            onClick={handleSend}
            disabled={disabled || isOverLimit || isProcessingImages}
          >
            <svg width="20" height="20" style={inputGlyphStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        ) : (
          <button
            style={{
              ...styles.actionBtn,
              ...styles.micBtn,
              ...(!isSupported ? styles.micBtnUnsupported : {}),
            }}
            onClick={handleMicToggle}
            disabled={disabled || isStreaming || isProcessingImages}
            title={unsupportedReason || '语音输入'}
            aria-label={unsupportedReason || '语音输入'}
          >
            <svg width="20" height="20" style={inputGlyphStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="1" width="6" height="12" rx="3" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
})

export default InputBar

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: 'calc(var(--keyboard-offset, 0px) + var(--native-keyboard-offset, 0px) + var(--input-bar-floating-lift, var(--input-bar-lift, 32px)))',
    left: 0,
    right: 0,
    padding: 'var(--chat-input-container-padding, 10px 12px)',
    paddingLeft: 'calc(var(--chat-input-container-padding-inline, 12px) + var(--safe-area-left))',
    paddingRight: 'calc(var(--chat-input-container-padding-inline, 12px) + var(--safe-area-right))',
    paddingBottom: 'var(--chat-input-container-padding-bottom, calc(10px + var(--keyboard-safe-area-bottom)))',
    paddingTop: 'var(--chat-input-container-padding-top, 16px)',
    // 豆包式柔和渐隐遮罩：底部完全实色（盖住文字），向上渐隐拉长，文字滚近输入框时被柔和遮住而非硬切。
    background: 'linear-gradient(to top, var(--color-bg) 0%, var(--color-bg) 46%, rgba(255, 251, 247, 0.92) 70%, rgba(255, 251, 247, 0))',
    zIndex: 20,
    transition: 'bottom 0.2s ease',
  },
  // 悬浮输入框下方的 lift 间隙补底：与容器底对齐，向下铺满到屏幕真实底部（含安全区/键盘偏移），
  // 用纯主题色挡死，避免文字从输入框与屏幕底之间的缝隙里透出来。
  bottomShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '100%',
    height: 'calc(var(--input-bar-floating-lift, var(--input-bar-lift, 32px)) + 1px)',
    background: 'var(--color-bg)',
    pointerEvents: 'none',
  },
  errorToast: {
    padding: '6px 12px',
    marginBottom: 6,
    borderRadius: 8,
    background: 'var(--color-error-bg)',
    color: 'var(--color-error)',
    fontSize: 13,
    textAlign: 'center',
  },
  previewRow: {
    display: 'flex',
    gap: 8,
    padding: '8px 4px',
    overflowX: 'auto',
  },
  previewItem: {
    position: 'relative',
    flexShrink: 0,
  },
  previewImg: {
    width: 64,
    height: 64,
    borderRadius: 10,
    objectFit: 'cover',
    border: '1px solid var(--color-border)',
  },
  previewImgUploading: {
    filter: 'saturate(0.72) brightness(0.82)',
  },
  previewUploadingOverlay: {
    position: 'absolute',
    inset: 0,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(24, 20, 18, 0.28)',
    pointerEvents: 'none',
  },
  previewSpinner: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '2.5px solid rgba(255, 255, 255, 0.58)',
    borderTopColor: '#fff',
    animation: 'spin 0.8s linear infinite',
    boxShadow: '0 2px 10px rgba(0,0,0,0.16)',
  },
  previewRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--color-error)',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  charCounter: {
    fontSize: 12,
    textAlign: 'right' as const,
    padding: '2px 12px 4px',
    fontVariantNumeric: 'tabular-nums',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--chat-input-row-gap, 10px)',
    minHeight: 'var(--chat-input-min-height, 64px)',
    background: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 999,
    padding: 'var(--chat-input-row-padding, 4px 4px 4px 12px)',
    border: '1px solid rgba(255, 255, 255, 0.82)',
    boxShadow: '0 14px 34px rgba(88, 62, 46, 0.10), inset 0 1px 0 rgba(255,255,255,0.88)',
    transition: 'box-shadow 0.2s',
  },
  plusBtn: {
    flexShrink: 0,
    width: 'var(--chat-input-icon-size, 36px)',
    height: 'var(--chat-input-icon-size, 36px)',
    borderRadius: '50%',
    background: 'linear-gradient(145deg, #FFF1E8, #FFF8F2)',
    color: 'var(--color-brand)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.92)',
    transition: 'color 0.2s, transform 0.2s',
    WebkitTouchCallout: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  textarea: {
    flex: 1,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    fontSize: 'var(--chat-input-font-size, var(--font-size-chat))',
    lineHeight: 'var(--chat-input-line-height, 1.5)',
    resize: 'none',
    maxHeight: 120,
    overflowY: 'auto',
    padding: 'var(--chat-input-textarea-padding, 8px 0)',
    color: 'var(--color-text)',
    fontWeight: 500,
  },
  inlineMicBtn: {
    flexShrink: 0,
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    background: 'var(--color-error)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 6px rgba(232,91,91,0.35)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  inlineMicDot: {
    width: 8,
    height: 8,
    background: '#fff',
    borderRadius: 2,
  },
  actionBtn: {
    flexShrink: 0,
    width: 'var(--chat-input-icon-size, 36px)',
    height: 'var(--chat-input-icon-size, 36px)',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.2s',
    WebkitTouchCallout: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  sendBtn: {
    background: 'var(--color-primary-gradient)',
    color: '#fff',
    boxShadow: '0 10px 22px rgba(255, 92, 28, 0.22)',
  },
  stopBtn: {
    background: 'var(--color-text)',
    color: '#fff',
  },
  micBtn: {
    background: 'linear-gradient(145deg, #FFF1E8, #FFF8F2)',
    color: 'var(--color-brand)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.92)',
  },
  micBtnUnsupported: {
    opacity: 0.45,
  },
}
