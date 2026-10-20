/**
 * TrainingItemSheet —— 跟练计划月历里单条事项的详情/播放浮窗
 *
 * 拉取 /todos/items/:id/resource 拿到可播放资源，按 kind 复用聊天里的三种播放器：
 * - 干预动作素材：InterventionMaterialInline（自带「开始跟练」+ 反馈完成回写）
 * - 外部视频：VideoResourceInline（读 resource.todoContext，自带反馈完成回写）
 * - 内部视频：InternalVideoInline（无 todo 反馈，额外挂一个 TodoFeedbackBar 做完成打卡）
 *
 * 任意完成动作都会把对应 todo 标记为 completed；浮窗关闭时父组件刷新月历即可看到 ✅。
 */

import { useEffect, useState } from 'react'
import type {
  ApiResponse,
  TodoItemPlayableResource,
  TodoItemResourceResponse,
  TodoToolTodoSummary,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import BottomSheet from '../ui/BottomSheet.js'
import InterventionMaterialInline from '../chat/InterventionMaterialInline.js'
import InternalVideoInline from '../chat/InternalVideoInline.js'
import VideoResourceInline from '../chat/VideoResourceInline.js'
import TodoFeedbackBar from '../chat/TodoFeedbackBar.js'

interface Props {
  open: boolean
  planTitle: string
  todo: TodoToolTodoSummary | null
  onClose: () => void
  onCompleted: () => void
}

function formatDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${Number(m[2])}月${Number(m[3])}日`
}

export default function TrainingItemSheet({ open, planTitle, todo, onClose, onCompleted }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resource, setResource] = useState<TodoItemPlayableResource | null>(null)
  const [manualFeedbackVisible, setManualFeedbackVisible] = useState(false)

  useEffect(() => {
    if (!open || !todo) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setResource(null)
    setManualFeedbackVisible(false)
    api.get<ApiResponse<TodoItemResourceResponse>>(`/todos/items/${encodeURIComponent(todo.id)}/resource`)
      .then((res) => {
        if (cancelled) return
        setResource(res.data?.resource ?? null)
      })
      .catch((err: any) => {
        if (cancelled) return
        setError(err?.message || '加载资源失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, todo])

  function renderBody() {
    if (loading) return <div style={styles.hint}>加载资源中…</div>
    if (error) return <div style={styles.error}>{error}</div>
    if (!resource) {
      return (
        <div style={styles.hint}>
          这条跟练的资源暂时无法加载，可回到对话里查看。
        </div>
      )
    }

    if (resource.kind === 'intervention_material') {
      return (
        <InterventionMaterialInline
          output={resource.output}
          sessionId={resource.sessionId}
          toolCallId={resource.toolCallId}
          source="materials"
          todoContext={resource.todoContext}
          onTodoFeedbackSubmit={() => onCompleted()}
        />
      )
    }

    if (resource.kind === 'video_resource') {
      return (
        <VideoResourceInline
          resource={resource.resource}
          sessionId={resource.sessionId}
          source="materials"
          onTodoFeedbackSubmit={() => onCompleted()}
        />
      )
    }

    // internal_video：播放器本身不回写 todo 完成，挂一个完成打卡入口
    const alreadyClosed = todo?.status === 'completed' || todo?.status === 'not_practiced'
    return (
      <div>
        <InternalVideoInline
          resource={resource.resource}
          sessionId={resource.sessionId}
          toolCallId={resource.toolCallId}
          source="materials"
        />
        {!alreadyClosed && (
          <button
            type="button"
            style={styles.completeBtn}
            onClick={() => setManualFeedbackVisible(true)}
          >
            练完了，记录一下感受
          </button>
        )}
        <TodoFeedbackBar
          visible={manualFeedbackVisible}
          sessionId={resource.sessionId}
          todoContext={resource.todoContext}
          onSubmitted={() => {
            setManualFeedbackVisible(false)
            onCompleted()
          }}
        />
      </div>
    )
  }

  const title = todo ? `${formatDate(todo.date)} ${todo.time}` : planTitle

  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div style={styles.planLabel}>{planTitle}</div>
      {renderBody()}
    </BottomSheet>
  )
}

const styles: Record<string, React.CSSProperties> = {
  planLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    marginBottom: 10,
  },
  hint: {
    padding: '32px 8px',
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--color-text-secondary)',
  },
  error: {
    padding: '24px 8px',
    textAlign: 'center',
    fontSize: 14,
    color: '#B04D3A',
  },
  completeBtn: {
    marginTop: 14,
    width: '100%',
    padding: '13px 16px',
    border: 'none',
    borderRadius: 14,
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
}
