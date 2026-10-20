import type {
  ApiResponse,
  MessageRecord,
  SessionListItem,
  SessionListResponse,
  ToolApprovalPayload,
  ScheduleConfirmationPayload,
  ToolCallRecord,
  ProfileAutoUpdatedPayload,
  MedicalDocumentSaveSuggestionPayload,
  MessageProcessStep,
  MessageImageAttachment,
} from '@health-agent/shared'
import type { StateCreator } from 'zustand'
import { api } from '../../services/api.js'
import { appendOrReplaceInterruptedAssistantMessage } from '../../utils/chatMessages.js'
import {
  readScheduleConfirmationSnapshot,
  writeScheduleConfirmationSnapshot,
} from '../../utils/scheduleConfirmationStore.js'

// ─── Process Timeline Types ───

type StreamingToolCallStep = Extract<MessageProcessStep, { type: 'tool_call' }> & {
  input?: unknown
  output?: unknown
}

type MedicalDocumentSaveSuggestionItem = MedicalDocumentSaveSuggestionPayload & {
  interacted?: boolean
}

export type ProcessStep =
  | Exclude<MessageProcessStep, { type: 'tool_call' }>
  | StreamingToolCallStep

export interface ProcessTimeline {
  steps: ProcessStep[]
  currentIteration: number
  isAnswering: boolean
  answerStartedAt: number | null
}

const EMPTY_TIMELINE: ProcessTimeline = { steps: [], currentIteration: 0, isAnswering: false, answerStartedAt: null }

// ─── Per-Session Streaming State ───
// 每条 SSE 流独立一个桶。新建会话 sid 未知时，以 send() 返回的 requestKey 暂 key；
// session 事件抵达后 rekey 到真 sid。切换视图仅改当前视图指向的桶，不 abort 其他桶。

export interface SessionStreamState {
  requestKey: string
  transport: 'stream' | 'sync'
  isStreaming: boolean
  isCompacting: boolean
  isThinking: boolean
  processTimeline: ProcessTimeline
  answerText: string
  thinkingStartTime: number | null
  responseStartTime: number | null
  stopRequested: boolean
  messageFinalized: boolean
  accumulatedToolCalls: ToolCallRecord[]
  // 桶绑定的消息归属 session。rekey 后等于真 sid；新建会话未 rekey 前为 null。
  boundSessionId: string | null
}

export const EMPTY_STREAM: SessionStreamState = {
  requestKey: '',
  transport: 'stream',
  isStreaming: false,
  isCompacting: false,
  isThinking: false,
  processTimeline: { ...EMPTY_TIMELINE },
  answerText: '',
  thinkingStartTime: null,
  responseStartTime: null,
  stopRequested: false,
  messageFinalized: false,
  accumulatedToolCalls: [],
  boundSessionId: null,
}

// ─── Chat Slice ───

export interface LastUserPayload {
  content: string
  images?: string[]
  imageAssetIds?: string[]
  imageAttachments?: MessageImageAttachment[]
}

export interface ChatSlice {
  sessions: SessionListItem[]
  /** 侧边栏下一页游标：最后一条 updatedAt ISO；null 表示没有更多 */
  sessionsCursor: string | null
  /** 侧边栏是否还有更早历史可加载 */
  sessionsHasMore: boolean
  /** 侧边栏首屏是否已加载过（缓存命中标志） */
  sessionsLoaded: boolean
  /** 侧边栏首屏加载中 */
  loadingSessions: boolean
  /** 侧边栏分页加载中（滚到底部） */
  loadingMoreSessions: boolean
  currentSessionId: string | null
  messages: MessageRecord[]
  /** 当前会话是否还有更早的历史消息可向上翻页 */
  hasMoreMessages: boolean
  /** 已加载消息中最早一条的 createdAt，作为 `before` 游标；无历史时为 null */
  oldestMessageCursor: string | null
  /** 正在向上拉历史（顶部触顶加载中） */
  isLoadingOlder: boolean
  /** 每个会话独立的 SSE 流状态桶，key 为 sessionId 或新建会话的临时 requestKey */
  sessionStreams: Record<string, SessionStreamState>
  feedbackMap: Record<string, 'like' | 'dislike'>
  favoriteMap: Record<string, true>
  processDurationMap: Record<string, number>
  /** 流式期间收到的 approval 缓冲区；message_end 后 flush 到 pendingApprovals */
  queuedApprovals: ToolApprovalPayload[]
  /** 结构化档案待用户确认的更新请求 FIFO 队列。MessageList 只渲染队首一张，点完自动下一张 */
  pendingApprovals: ToolApprovalPayload[]
  /** 已处理的 approvalId → 'approved' | 'rejected'，用于结果反馈 */
  approvalResults: Record<string, 'approved' | 'rejected'>
  /** schedule 工具确认卡：流式期间缓冲，message_end 后 flush 到 pendingScheduleConfirmations */
  queuedScheduleConfirmations: ScheduleConfirmationPayload[]
  /** schedule 待用户确认队列。MessageList 只渲染队首一张，点完自动下一张 */
  pendingScheduleConfirmations: ScheduleConfirmationPayload[]
  /** 已处理的 confirmationId → 'confirmed' | 'rejected' */
  scheduleConfirmationResults: Record<string, 'confirmed' | 'rejected'>
  /** personal 字段由工具自动落库后推送的只读提示条列表（非阻塞，仅用于展示） */
  profileNotices: ProfileAutoUpdatedPayload[]
  /** 病历解读工具调用时，提示用户可将本轮图片异步保存到健康档案 */
  medicalDocumentSaveSuggestions: MedicalDocumentSaveSuggestionItem[]
  /** 当前前端会话内，已被病历解读确认的用户图片消息 */
  privacyProtectedImageMessageIds: Record<string, true>
  /** 最近一次用户发送的内容，用于错误后重试 */
  lastUserPayload: LastUserPayload | null

  setSessions: (sessions: SessionListItem[]) => void
  /** 首屏拉取（默认仅在未加载过时执行；force=true 重新拉取） */
  loadSessions: (force?: boolean) => Promise<void>
  /** 滚动到底部加载下一页 */
  loadMoreSessions: () => Promise<void>
  /** 新建/标题更新/发送消息后把会话置顶 */
  upsertSession: (session: SessionListItem) => void
  /** 删除会话后从列表移除 */
  removeSession: (sessionId: string) => void
  setCurrentSession: (sessionId: string | null) => void
  setMessages: (messages: MessageRecord[]) => void
  /** 把更早的一页消息拼到现有列表头部（已假定传入是 ASC 排序） */
  prependMessages: (older: MessageRecord[]) => void
  setHasMoreMessages: (v: boolean) => void
  setOldestMessageCursor: (cursor: string | null) => void
  setLoadingOlder: (v: boolean) => void
  addMessage: (message: MessageRecord) => void
  removeMessage: (messageId: string) => void
  setLastUserPayload: (payload: LastUserPayload | null) => void

  // ─── Per-session stream actions ───
  initStream: (
    key: string,
    requestKey: string,
    boundSessionId: string | null,
    transport?: 'stream' | 'sync',
  ) => void
  rekeyStream: (from: string, to: string) => void
  clearStream: (key: string) => void
  updateStream: (key: string, patch: Partial<SessionStreamState>) => void
  streamStartIteration: (key: string, iteration: number) => void
  streamAppendThinking: (key: string, content: string) => void
  streamEndThinking: (key: string) => void
  streamStartToolCall: (key: string, data: { toolCallId: string; name: string; input?: unknown }) => void
  streamEndToolCall: (key: string, data: { toolCallId: string; name: string; output?: unknown; durationMs: number }) => void
  streamDocumentAttached: (key: string, data: { titles: Array<string | null>; count: number }) => void
  streamAppendText: (key: string, content: string) => void
  streamStartAnswer: (key: string) => void
  streamAppendAnswerText: (key: string, content: string) => void
  streamRetractDraft: (
    key: string,
    opts?: {
      recoveryReason?: string
      retryAttempt?: number
      displayAsToolPlan?: boolean
      toolName?: string
      clearTransientToolPlan?: boolean
    },
  ) => void
  /**
   * 流结束落地消息到所属 session：
   * - 若桶 boundSessionId 与当前视图 currentSessionId 一致，push 到 messages 数组
   * - 不一致（用户已切走）则仅记录 processDurationMap，依赖后端持久化 + 下次拉历史恢复
   * 总是清桶。
   */
  streamFinalizeMessage: (key: string, message: MessageRecord) => void

  finalizeMessage: (message: MessageRecord) => void
  setFeedbackMap: (map: Record<string, 'like' | 'dislike'>) => void
  setFeedback: (messageId: string, rating: 'like' | 'dislike' | null) => void
  setFavoriteMap: (map: Record<string, true>) => void
  setFavorite: (messageId: string, saved: boolean) => void

  // Approval actions
  /** 流式期间 enqueue 到 queuedApprovals；不立即显示 */
  queueApproval: (payload: ToolApprovalPayload) => void
  /** 流式结束后调用；把 queuedApprovals FIFO 拼到 pendingApprovals 并清空缓冲 */
  flushApprovals: () => void
  /** (保留) 立即添加到 pendingApprovals；同 field 覆盖，FIFO 保持原先顺序 */
  addApproval: (payload: ToolApprovalPayload) => void
  /** 用户同意/拒绝后从 pendingApprovals 移除 */
  resolveApproval: (approvalId: string, result: 'approved' | 'rejected') => void
  /** 切换会话时清空未处理的 approval 队列（approvalResults 保留） */
  clearApprovals: () => void

  // Schedule confirmation actions（与 approval 三件套同构，去重键为 confirmationId）
  /** 流式期间 enqueue 到 queuedScheduleConfirmations；不立即显示 */
  queueScheduleConfirmation: (payload: ScheduleConfirmationPayload) => void
  /** 流式结束后调用；把 queued 拼到 pending 并清空缓冲 */
  flushScheduleConfirmations: () => void
  /** 用户确认/拒绝后从 pending 移除 */
  resolveScheduleConfirmation: (confirmationId: string, result: 'confirmed' | 'rejected') => void
  /** 切换会话时清空未处理的 schedule 确认队列（results 保留） */
  clearScheduleConfirmations: () => void
  /** message_end 落地后：把当前还没 messageId 的 schedule 确认卡补上 messageId，供点击后回写定位 */
  attachMessageIdToScheduleConfirmations: (messageId: string) => void
  /**
   * 进入某会话后从 sessionStorage 还原该会话仍待确认的卡片：
   * 仅保留 messageId 属于本会话、且尚未在 results 里登记过结果的卡片，
   * 避免重复弹出已确认/已拒绝（这些由 processTimeline 终态自行展示）。
   */
  restoreScheduleConfirmationsForMessages: (sessionMessageIds: string[]) => void
  /** 用户点完后：更新内存里该 message 的 processTimeline 中对应 toolCall 的终态，当前会话即时显示 */
  markScheduleStepInMessage: (messageId: string, toolCallId: string, status: 'confirmed' | 'rejected', scheduledTaskId?: string | null) => void
  /** 用户拒绝健康档案授权时，仅移除仍依赖该授权的确认卡片 */
  dropApprovalsRequiringHealthProfileConsent: () => void

  // Profile auto-update notices (personal fields: nickname/birthday/gender)
  /** 收到工具自动落库通知，追加到列表；同 field 用新值覆盖旧值 */
  addProfileNotice: (payload: ProfileAutoUpdatedPayload) => void
  /** 用户主动关闭某条通知 */
  dismissProfileNotice: (noticeId: string) => void
  /** 切换会话时清空 */
  clearProfileNotices: () => void

  // Medical document save suggestions
  addMedicalDocumentSaveSuggestion: (payload: MedicalDocumentSaveSuggestionPayload) => void
  markMedicalDocumentSaveSuggestionInteracted: (suggestionId: string) => void
  dismissUntouchedMedicalDocumentSaveSuggestionsForToolCall: (toolCallId: string) => void
  dismissMedicalDocumentSaveSuggestion: (suggestionId: string) => void
  clearMedicalDocumentSaveSuggestions: () => void
  markMessageImagesPrivacyProtected: (messageId: string) => void
}

// 以桶上一轮 state 为起点应用 patch（不存在则从 EMPTY_STREAM 起）
function patchBucket(
  streams: Record<string, SessionStreamState>,
  key: string,
  patch: Partial<SessionStreamState>,
): Record<string, SessionStreamState> {
  const current = streams[key] ?? EMPTY_STREAM
  return { ...streams, [key]: { ...current, ...patch } }
}

export const createChatSlice: StateCreator<ChatSlice, [], [], ChatSlice> = (set, get) => {
  // 会话列表属于当前登录态的缓存。切账号或后发请求返回时，旧响应必须失效，
  // 否则会把上一账号的历史重新写回侧边栏，点进去再被后端 404 挡住。
  let sessionsRequestSeq = 0
  const getAuthEpoch = () => {
    const state = (get as unknown as () => { authEpoch?: number })()
    return typeof state.authEpoch === 'number' ? state.authEpoch : 0
  }

  // schedule 待确认卡片旁路持久化：每次 pending/results 变化后落 sessionStorage，
  // 供导航离开聊天页再返回时还原（确认前后端不落库，丢了就再也确认不了）。
  const persistScheduleConfirmations = () => {
    const state = get()
    writeScheduleConfirmationSnapshot({
      pending: state.pendingScheduleConfirmations,
      results: state.scheduleConfirmationResults,
    })
  }

  return ({
  sessions: [],
  sessionsCursor: null,
  sessionsHasMore: false,
  sessionsLoaded: false,
  loadingSessions: false,
  loadingMoreSessions: false,
  currentSessionId: null,
  messages: [],
  hasMoreMessages: false,
  oldestMessageCursor: null,
  isLoadingOlder: false,
  sessionStreams: {},
  feedbackMap: {},
  favoriteMap: {},
  processDurationMap: {},
  queuedApprovals: [],
  pendingApprovals: [],
  approvalResults: {},
  queuedScheduleConfirmations: [],
  pendingScheduleConfirmations: [],
  scheduleConfirmationResults: {},
  profileNotices: [],
  medicalDocumentSaveSuggestions: [],
  privacyProtectedImageMessageIds: {},
  lastUserPayload: null,

  setSessions: (sessions) => set({ sessions }),

  loadSessions: async (force = false) => {
    const { sessionsLoaded, loadingSessions } = get()
    if (loadingSessions) return
    if (sessionsLoaded && !force) return

    const authEpoch = getAuthEpoch()
    const requestSeq = ++sessionsRequestSeq
    set({ loadingSessions: true })
    try {
      const res = await api.get<ApiResponse<SessionListResponse>>(`/sessions?limit=30&_ae=${authEpoch}`)
      const data = res.data
      if (data && requestSeq === sessionsRequestSeq && getAuthEpoch() === authEpoch) {
        set({
          sessions: data.items,
          sessionsCursor: data.nextCursor,
          sessionsHasMore: data.hasMore,
          sessionsLoaded: true,
        })
      }
    } catch {
      // 失败不写入缓存，允许下次重试
    } finally {
      if (requestSeq === sessionsRequestSeq && getAuthEpoch() === authEpoch) {
        set({ loadingSessions: false })
      }
    }
  },

  loadMoreSessions: async () => {
    const { sessionsHasMore, sessionsCursor, loadingMoreSessions, loadingSessions } = get()
    if (!sessionsHasMore || !sessionsCursor) return
    if (loadingMoreSessions || loadingSessions) return

    const authEpoch = getAuthEpoch()
    const requestSeq = ++sessionsRequestSeq
    set({ loadingMoreSessions: true })
    try {
      const qs = `?limit=30&before=${encodeURIComponent(sessionsCursor)}&_ae=${authEpoch}`
      const res = await api.get<ApiResponse<SessionListResponse>>(`/sessions${qs}`)
      const data = res.data
      if (data && requestSeq === sessionsRequestSeq && getAuthEpoch() === authEpoch) {
        set((state) => {
          const existing = new Set(state.sessions.map((s) => s.id))
          const merged = [...state.sessions, ...data.items.filter((s) => !existing.has(s.id))]
          return {
            sessions: merged,
            sessionsCursor: data.nextCursor,
            sessionsHasMore: data.hasMore,
          }
        })
      }
    } catch {
      // silent
    } finally {
      if (requestSeq === sessionsRequestSeq && getAuthEpoch() === authEpoch) {
        set({ loadingMoreSessions: false })
      }
    }
  },

  upsertSession: (session) =>
    set((state) => {
      const rest = state.sessions.filter((s) => s.id !== session.id)
      return { sessions: [session, ...rest] }
    }),

  removeSession: (sessionId) =>
    set((state) => ({ sessions: state.sessions.filter((s) => s.id !== sessionId) })),

  setCurrentSession: (sessionId) => set({ currentSessionId: sessionId }),
  setMessages: (messages) => set({ messages }),
  prependMessages: (older) =>
    set((state) => ({ messages: [...older, ...state.messages] })),
  setHasMoreMessages: (v) => set({ hasMoreMessages: v }),
  setOldestMessageCursor: (cursor) => set({ oldestMessageCursor: cursor }),
  setLoadingOlder: (v) => set({ isLoadingOlder: v }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  removeMessage: (messageId) =>
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) })),
  setLastUserPayload: (payload) => set({ lastUserPayload: payload }),

  // ─── Per-session stream actions ───

  initStream: (key, requestKey, boundSessionId, transport = 'stream') =>
    set((state) => ({
      sessionStreams: {
        ...state.sessionStreams,
        [key]: {
          ...EMPTY_STREAM,
          requestKey,
          transport,
          boundSessionId,
          isStreaming: true,
          processTimeline: { ...EMPTY_TIMELINE },
        },
      },
    })),

  rekeyStream: (from, to) =>
    set((state) => {
      if (from === to) return state
      const bucket = state.sessionStreams[from]
      if (!bucket) return state
      const next = { ...state.sessionStreams }
      delete next[from]
      next[to] = { ...bucket, boundSessionId: to }
      return { sessionStreams: next }
    }),

  clearStream: (key) =>
    set((state) => {
      if (!state.sessionStreams[key]) return state
      const next = { ...state.sessionStreams }
      delete next[key]
      return { sessionStreams: next }
    }),

  updateStream: (key, patch) =>
    set((state) => ({ sessionStreams: patchBucket(state.sessionStreams, key, patch) })),

  streamStartIteration: (key, iteration) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      if (iteration <= 1) {
        return {
          sessionStreams: patchBucket(state.sessionStreams, key, {
            processTimeline: { ...bucket.processTimeline, currentIteration: iteration },
          }),
        }
      }
      // New iteration after tool calls — keep agent narration steps visible, but close
      // transient tool-plan rows and any lingering active thinking so the next real
      // tool / answer can become active.
      const steps = bucket.processTimeline.steps
        .map((s) => (s.type === 'tool_plan' || s.type === 'thinking') && s.isActive ? { ...s, isActive: false } : s)
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          processTimeline: {
            ...bucket.processTimeline,
            steps,
            currentIteration: iteration,
            isAnswering: false,
            answerStartedAt: null,
          },
        }),
      }
    }),

  streamAppendThinking: (key, content) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      const steps = [...bucket.processTimeline.steps]
      // 关掉仍然活跃的 doc_view（thinking 一来就不再"查看图片中"）
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]
        if (s.type === 'doc_view' && s.isActive) {
          steps[i] = { ...s, isActive: false }
          break
        }
      }
      const last = steps[steps.length - 1]
      if (last?.type === 'thinking' && last.isActive) {
        steps[steps.length - 1] = { ...last, content: last.content + content }
      } else {
        steps.push({ type: 'thinking', content, isActive: true, timestamp: Date.now() })
      }
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          processTimeline: { ...bucket.processTimeline, steps },
        }),
      }
    }),

  streamEndThinking: (key) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      const steps = [...bucket.processTimeline.steps]
      const last = steps[steps.length - 1]
      if (last?.type === 'thinking' && last.isActive) {
        steps[steps.length - 1] = { ...last, isActive: false }
      }
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          processTimeline: { ...bucket.processTimeline, steps },
          isThinking: false,
        }),
      }
    }),

  streamStartToolCall: (key, data) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      // 后端可能两次发 tool_call_start：
      //   1. client.ts 在 LLM stream tool_call delta 时早期通知（让 UI 立即占位）
      //   2. loop.ts 在准备执行工具时再发一次（兜底，兼容 deny / 旧客户端）
      // 这里按 toolCallId 对已 active 的同一 step dedup，避免 timeline 重复 push。
      if (data.toolCallId) {
        const existingIdx = bucket.processTimeline.steps.findIndex(
          (s) =>
            s.type === 'tool_call' &&
            s.isActive &&
            s.toolCallId === data.toolCallId,
        )
        if (existingIdx >= 0) {
          if (data.input === undefined) return state
          const steps = [...bucket.processTimeline.steps]
          const current = steps[existingIdx]
          steps[existingIdx] = current.type === 'tool_call'
            ? { ...current, input: data.input }
            : current
          return {
            sessionStreams: patchBucket(state.sessionStreams, key, {
              processTimeline: { ...bucket.processTimeline, steps },
            }),
          }
        }
      }
      const steps = bucket.processTimeline.steps.map((s) =>
        s.type === 'tool_plan' ? { ...s, isActive: false } : s)
      // fallback-no-tag 会把工具调用前的中间叙述当成 answer 流式下发。一旦后面又来了工具
      // 调用，说明这段文字其实是过程叙述而非最终回答：固化成 text 过程节点（保留时间顺序），
      // 清空 answerText，避免它被当成底部最终答案堆在最后。
      const pendingAnswerDraft = bucket.answerText
      if (pendingAnswerDraft.trim()) {
        const lastStep = steps[steps.length - 1]
        if (lastStep?.type === 'text') {
          steps[steps.length - 1] = { ...lastStep, content: lastStep.content + pendingAnswerDraft }
        } else {
          steps.push({ type: 'text', content: pendingAnswerDraft, timestamp: Date.now() })
        }
      }
      steps.push({
        type: 'tool_call',
        toolCallId: data.toolCallId,
        name: data.name,
        input: data.input,
        isActive: true,
        timestamp: Date.now(),
      })
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          answerText: pendingAnswerDraft.trim() ? '' : bucket.answerText,
          processTimeline: {
            ...bucket.processTimeline,
            steps,
            isAnswering: false,
            answerStartedAt: null,
          },
        }),
      }
    }),

  streamEndToolCall: (key, data) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      const steps = [...bucket.processTimeline.steps]
      let matchedInput: unknown = null
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]
        if (
          s.type === 'tool_call' &&
          s.isActive &&
          (s.toolCallId ? s.toolCallId === data.toolCallId : s.name === data.name)
        ) {
          matchedInput = s.input ?? null
          steps[i] = { ...s, output: data.output, durationMs: data.durationMs, isActive: false }
          break
        }
      }
      const tc: ToolCallRecord = {
        toolCallId: data.toolCallId,
        name: data.name,
        input: matchedInput,
        output: data.output ?? null,
        durationMs: data.durationMs,
      }
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          processTimeline: { ...bucket.processTimeline, steps },
          accumulatedToolCalls: [...bucket.accumulatedToolCalls, tc],
        }),
      }
    }),

  streamAppendText: (key, content) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      const steps = [...bucket.processTimeline.steps]
      // 关掉仍然活跃的 doc_view（text 一来就不再"查看图片中"）
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]
        if (s.type === 'doc_view' && s.isActive) {
          steps[i] = { ...s, isActive: false }
          break
        }
      }
      const last = steps[steps.length - 1]
      if (last?.type === 'text') {
        steps[steps.length - 1] = { ...last, content: last.content + content }
      } else {
        steps.push({ type: 'text', content, timestamp: Date.now() })
      }
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          processTimeline: { ...bucket.processTimeline, steps },
        }),
      }
    }),

  streamDocumentAttached: (key, data) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      const steps = [...bucket.processTimeline.steps]
      steps.push({
        type: 'doc_view',
        titles: data.titles,
        count: data.count,
        isActive: true,
        timestamp: Date.now(),
      })
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          processTimeline: { ...bucket.processTimeline, steps },
        }),
      }
    }),

  streamStartAnswer: (key) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      const steps = bucket.processTimeline.steps.map((step) =>
        step.type === 'protocol_recovery' || step.type === 'tool_plan'
          ? { ...step, isActive: false }
          : step)
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          processTimeline: {
            ...bucket.processTimeline,
            steps,
            isAnswering: true,
            answerStartedAt: bucket.processTimeline.answerStartedAt ?? Date.now(),
          },
        }),
      }
    }),

  streamAppendAnswerText: (key, content) =>
    set((state) => {
      const bucket = state.sessionStreams[key] ?? EMPTY_STREAM
      const combined = bucket.answerText + content
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          answerText: combined,
        }),
      }
    }),

  streamRetractDraft: (key, opts) =>
    set((state) => {
      const bucket = state.sessionStreams[key]
      if (!bucket) return state
      const steps = bucket.processTimeline.steps.filter((s) => {
        if (opts?.clearTransientToolPlan && s.type === 'tool_plan' && s.transient) return false
        return (
          s.type === 'tool_call' ||
          s.type === 'doc_view' ||
          s.type === 'protocol_recovery'
        )
      }).map((s) => (
        s.type === 'protocol_recovery'
          ? { ...s, isActive: false }
          : s
      ))
      if (opts?.displayAsToolPlan && opts.toolName) {
        steps.push({
          type: 'tool_plan',
          content: '',
          toolName: opts.toolName,
          transient: true,
          isActive: true,
          timestamp: Date.now(),
        })
      }
      if (opts?.recoveryReason) {
        steps.push({
          type: 'protocol_recovery',
          reason: opts.recoveryReason,
          retryAttempt: opts.retryAttempt,
          isActive: true,
          timestamp: Date.now(),
        })
      }
      return {
        sessionStreams: patchBucket(state.sessionStreams, key, {
          answerText: '',
          responseStartTime: null,
          processTimeline: {
            ...bucket.processTimeline,
            steps,
            isAnswering: false,
            answerStartedAt: null,
          },
        }),
      }
    }),

  streamFinalizeMessage: (key, message) =>
    set((state) => {
      const bucket = state.sessionStreams[key]
      if (!bucket) return state

      // 时长 = 第一个前台过程节点开始 → answer 开始
      const processSteps = bucket.processTimeline.steps.filter(
        (s) =>
          s.type === 'thinking' ||
          s.type === 'tool_call' ||
          s.type === 'doc_view' ||
          s.type === 'protocol_recovery',
      )
      const firstTs = processSteps.length > 0 ? processSteps[0].timestamp : 0
      const endTs = bucket.processTimeline.answerStartedAt || Date.now()
      const durationMs = firstTs > 0 ? endTs - firstTs : 0

      const nextStreams = { ...state.sessionStreams }
      delete nextStreams[key]

      // 桶所属 session 就是当前视图 → push 到 messages 数组
      // 双 null 也算命中：新会话未 rekey 时，桶 boundSessionId 与 currentSessionId 都是 null，
      // 用户仍在新对话页，消息应进 messages
      const isCurrentView = state.currentSessionId === bucket.boundSessionId
      const nextMessages = isCurrentView
        ? appendOrReplaceInterruptedAssistantMessage(state.messages, message)
        : state.messages

      return {
        sessionStreams: nextStreams,
        messages: nextMessages,
        processDurationMap: durationMs > 0
          ? { ...state.processDurationMap, [message.id]: durationMs }
          : state.processDurationMap,
      }
    }),

  // Legacy 入口（保留给非 SSE 路径一次性落消息 + 清"当前视图"桶的需要）
  finalizeMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  setFeedbackMap: (feedbackMap) => set({ feedbackMap }),
  setFeedback: (messageId, rating) =>
    set((state) => {
      const next = { ...state.feedbackMap }
      if (rating === null) {
        delete next[messageId]
      } else {
        next[messageId] = rating
      }
      return { feedbackMap: next }
    }),
  setFavoriteMap: (favoriteMap) => set({ favoriteMap }),
  setFavorite: (messageId, saved) =>
    set((state) => {
      const next = { ...state.favoriteMap }
      if (saved) {
        next[messageId] = true
      } else {
        delete next[messageId]
      }
      return { favoriteMap: next }
    }),

  queueApproval: (payload) =>
    set((state) => {
      // 同一字段只保留最新一张，避免流式期间多轮 tool_call 堆积同字段卡片
      const filtered = state.queuedApprovals.filter((a) => a.field !== payload.field)
      return { queuedApprovals: [...filtered, payload] }
    }),

  flushApprovals: () =>
    set((state) => {
      if (state.queuedApprovals.length === 0) return state
      // 对齐语义：pendingApprovals 中同字段也用新的覆盖旧的
      const queuedFields = new Set(state.queuedApprovals.map((a) => a.field))
      const preserved = state.pendingApprovals.filter((a) => !queuedFields.has(a.field))
      return {
        pendingApprovals: [...preserved, ...state.queuedApprovals],
        queuedApprovals: [],
      }
    }),

  addApproval: (payload) =>
    set((state) => {
      const filtered = state.pendingApprovals.filter((a) => a.field !== payload.field)
      return { pendingApprovals: [...filtered, payload] }
    }),

  resolveApproval: (approvalId, result) =>
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.approvalId !== approvalId),
      approvalResults: { ...state.approvalResults, [approvalId]: result },
    })),

  clearApprovals: () => set({ queuedApprovals: [], pendingApprovals: [] }),

  queueScheduleConfirmation: (payload) =>
    set((state) => {
      const filtered = state.queuedScheduleConfirmations.filter((a) => a.confirmationId !== payload.confirmationId)
      return { queuedScheduleConfirmations: [...filtered, payload] }
    }),

  flushScheduleConfirmations: () => {
    set((state) => {
      if (state.queuedScheduleConfirmations.length === 0) return state
      const queuedIds = new Set(state.queuedScheduleConfirmations.map((a) => a.confirmationId))
      const preserved = state.pendingScheduleConfirmations.filter((a) => !queuedIds.has(a.confirmationId))
      return {
        pendingScheduleConfirmations: [...preserved, ...state.queuedScheduleConfirmations],
        queuedScheduleConfirmations: [],
      }
    })
    persistScheduleConfirmations()
  },

  resolveScheduleConfirmation: (confirmationId, result) => {
    set((state) => ({
      pendingScheduleConfirmations: state.pendingScheduleConfirmations.filter((a) => a.confirmationId !== confirmationId),
      scheduleConfirmationResults: { ...state.scheduleConfirmationResults, [confirmationId]: result },
    }))
    persistScheduleConfirmations()
  },

  // 只清内存队列，不动 sessionStorage 快照：还原依赖它，切视图清掉就再也恢复不了。
  clearScheduleConfirmations: () => set({ queuedScheduleConfirmations: [], pendingScheduleConfirmations: [] }),

  attachMessageIdToScheduleConfirmations: (messageId) => {
    set((state) => {
      const patch = (list: ScheduleConfirmationPayload[]) =>
        list.map((c) => (c.messageId ? c : { ...c, messageId }))
      return {
        queuedScheduleConfirmations: patch(state.queuedScheduleConfirmations),
        pendingScheduleConfirmations: patch(state.pendingScheduleConfirmations),
      }
    })
    persistScheduleConfirmations()
  },

  restoreScheduleConfirmationsForMessages: (sessionMessageIds) => {
    const snapshot = readScheduleConfirmationSnapshot()
    if (snapshot.pending.length === 0) {
      // 仍把历史 results 合回内存，供 ProcessIndicator/重复点击去重
      if (Object.keys(snapshot.results).length > 0) {
        set((state) => ({
          scheduleConfirmationResults: { ...snapshot.results, ...state.scheduleConfirmationResults },
        }))
      }
      return
    }
    const idSet = new Set(sessionMessageIds)
    const restorable = snapshot.pending.filter(
      (c) => c.messageId != null
        && idSet.has(c.messageId)
        && !snapshot.results[c.confirmationId],
    )
    set((state) => {
      const existingIds = new Set(state.pendingScheduleConfirmations.map((a) => a.confirmationId))
      const merged = [
        ...state.pendingScheduleConfirmations,
        ...restorable.filter((c) => !existingIds.has(c.confirmationId)),
      ]
      return {
        pendingScheduleConfirmations: merged,
        scheduleConfirmationResults: { ...snapshot.results, ...state.scheduleConfirmationResults },
      }
    })
  },

  markScheduleStepInMessage: (messageId, toolCallId, status, scheduledTaskId) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId || !m.processTimeline) return m
        let changed = false
        const processTimeline = m.processTimeline.map((step) => {
          if (step.type === 'tool_call' && step.toolCallId === toolCallId) {
            changed = true
            return {
              ...step,
              scheduleConfirmation: status,
              ...(scheduledTaskId ? { scheduledTaskId } : {}),
            }
          }
          return step
        })
        return changed ? { ...m, processTimeline } : m
      }),
    })),

  dropApprovalsRequiringHealthProfileConsent: () =>
    set((state) => ({
      queuedApprovals: state.queuedApprovals.filter((a) => !a.requiresHealthProfileConsent),
      pendingApprovals: state.pendingApprovals.filter((a) => !a.requiresHealthProfileConsent),
    })),

  addProfileNotice: (payload) =>
    set((state) => {
      const filtered = state.profileNotices.filter((n) => n.field !== payload.field)
      return { profileNotices: [...filtered, payload] }
    }),

  dismissProfileNotice: (noticeId) =>
    set((state) => ({
      profileNotices: state.profileNotices.filter((n) => n.noticeId !== noticeId),
    })),

  clearProfileNotices: () => set({ profileNotices: [] }),

  addMedicalDocumentSaveSuggestion: (payload) =>
    set((state) => {
      const existing = state.medicalDocumentSaveSuggestions.find(
        (item) => item.suggestionId === payload.suggestionId,
      )
      const filtered = state.medicalDocumentSaveSuggestions.filter(
        (item) => item.suggestionId !== payload.suggestionId,
      )
      return {
        privacyProtectedImageMessageIds: {
          ...state.privacyProtectedImageMessageIds,
          [payload.sourceMessageId]: true,
        },
        medicalDocumentSaveSuggestions: [
          ...filtered,
          { ...payload, interacted: existing?.interacted ?? false },
        ],
      }
    }),

  markMedicalDocumentSaveSuggestionInteracted: (suggestionId) =>
    set((state) => ({
      medicalDocumentSaveSuggestions: state.medicalDocumentSaveSuggestions.map((item) =>
        item.suggestionId === suggestionId ? { ...item, interacted: true } : item,
      ),
    })),

  dismissUntouchedMedicalDocumentSaveSuggestionsForToolCall: (toolCallId) =>
    set((state) => ({
      medicalDocumentSaveSuggestions: state.medicalDocumentSaveSuggestions.filter(
        (item) => item.toolCallId !== toolCallId || item.interacted,
      ),
    })),

  dismissMedicalDocumentSaveSuggestion: (suggestionId) =>
    set((state) => ({
      medicalDocumentSaveSuggestions: state.medicalDocumentSaveSuggestions.filter(
        (item) => item.suggestionId !== suggestionId,
      ),
    })),

  clearMedicalDocumentSaveSuggestions: () => set({ medicalDocumentSaveSuggestions: [] }),

  markMessageImagesPrivacyProtected: (messageId) =>
    set((state) => ({
      privacyProtectedImageMessageIds: {
        ...state.privacyProtectedImageMessageIds,
        [messageId]: true,
      },
    })),
  })
}
