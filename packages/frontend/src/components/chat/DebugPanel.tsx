import { useState } from 'react'
import { api } from '../../services/api.js'
import type { ApiResponse } from '@health-agent/shared'

interface DebugMessage {
  role: string
  content: string
  tool_calls?: unknown[]
  tool_call_id?: string
}

interface DebugTool {
  type: string
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

interface PrefixStability {
  status: 'stable' | 'changed' | 'compaction' | 'reset' | 'unknown'
  lastReason?: string
  lastIter?: number
}

interface DebugData {
  sessionId: string
  model: string
  systemPromptLength: number
  messagesCount: number
  messages: DebugMessage[]
  tools?: DebugTool[]
  prefixStability?: PrefixStability
}

const PREFIX_LAMP_CONFIG: Record<
  PrefixStability['status'],
  { color: string; bg: string; label: string; title: string }
> = {
  stable: {
    color: '#10B981',
    bg: 'rgba(16,185,129,0.15)',
    label: 'Prefix',
    title: 'Prefix 稳定 — 上轮 KV cache 可命中',
  },
  changed: {
    color: '#E74C3C',
    bg: 'rgba(231,76,60,0.18)',
    label: 'Prefix · MISS',
    title: 'Prefix 非预期变化 — 击穿 KV cache，详见后端日志',
  },
  compaction: {
    color: '#F59E0B',
    bg: 'rgba(245,158,11,0.18)',
    label: 'Prefix · compacted',
    title: '触发压缩，prefix 合理变化',
  },
  reset: {
    color: '#3B82F6',
    bg: 'rgba(59,130,246,0.18)',
    label: 'Prefix · reset',
    title: 'Prefix baseline 被显式重置（retry / legacy tool replay 等），非上下文压缩',
  },
  unknown: {
    color: '#94A3B8',
    bg: 'rgba(148,163,184,0.15)',
    label: 'Prefix',
    title: '尚无 prefix 对比数据（首轮或 Redis 不可用）',
  },
}

interface Props {
  sessionId: string | null
  onClose: () => void
}

export default function DebugPanel({ sessionId, onClose }: Props) {
  const [data, setData] = useState<DebugData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [expandedToolName, setExpandedToolName] = useState<string | null>(null)

  async function loadContext() {
    if (!sessionId) {
      setError('No active session')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.get<ApiResponse<DebugData>>(`/chat/debug/${sessionId}`)
      if (res.data) setData(res.data)
    } catch (err: any) {
      setError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  // Auto-load on mount
  if (!data && !loading && !error) {
    loadContext()
  }

  function toggleExpand(idx: number) {
    setExpandedIdx(expandedIdx === idx ? null : idx)
  }

  function toggleTool(name: string) {
    setExpandedToolName(expandedToolName === name ? null : name)
  }

  const roleLabels: Record<string, string> = {
    system: 'System Prompt',
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
  }

  const roleColors: Record<string, string> = {
    system: '#2563EB',
    user: 'var(--color-primary)',
    assistant: '#10B981',
    tool: '#6B7280',
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.headerIcon}>&#123;&#125;</span>
            <span style={styles.headerTitle}>LLM Context</span>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Meta info */}
        {data && (
          <div style={styles.meta}>
            <span style={styles.metaTag}>Model: {data.model}</span>
            <span style={styles.metaTag}>Messages: {data.messagesCount}</span>
            <span style={styles.metaTag}>Prompt: {data.systemPromptLength} chars</span>
            {(() => {
              const cfg = PREFIX_LAMP_CONFIG[data.prefixStability?.status ?? 'unknown']
              const reason = data.prefixStability?.lastReason
              const iter = data.prefixStability?.lastIter
              const statusWithReason = new Set(['changed', 'compaction', 'reset'])
              const suffix = reason && statusWithReason.has(data.prefixStability?.status ?? '')
                ? ` · ${reason}${iter != null ? ` @iter${iter}` : ''}`
                : ''
              return (
                <span
                  title={cfg.title}
                  style={{ ...styles.metaTag, background: cfg.bg, color: cfg.color, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: cfg.color,
                    boxShadow: `0 0 4px ${cfg.color}`,
                  }} />
                  {cfg.label}{suffix}
                </span>
              )
            })()}
          </div>
        )}

        {/* Content */}
        <div style={styles.content}>
          {loading && <p style={styles.status}>Loading...</p>}
          {error && <p style={{ ...styles.status, color: '#E74C3C' }}>{error}</p>}

          {data?.tools?.map((tool) => {
            const expanded = expandedToolName === tool.function.name
            return (
              <div key={tool.function.name} style={styles.messageCard}>
                <button
                  style={styles.messageHeader}
                  onClick={() => toggleTool(tool.function.name)}
                >
                  <div style={styles.messageHeaderLeft}>
                    <span style={{
                      ...styles.roleBadge,
                      background: '#7C3AED',
                    }}>
                      Tool Schema
                    </span>
                    <span style={styles.charCount}>
                      {tool.function.name}
                    </span>
                  </div>
                  <svg
                    width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="var(--color-text-muted)" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{
                      transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s',
                    }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {expanded && (
                  <pre style={styles.messageContent}>
                    {JSON.stringify(tool, null, 2)}
                  </pre>
                )}
              </div>
            )
          })}

          {data?.messages.map((msg, idx) => {
            const isToolCallAssistant = msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
            const label = isToolCallAssistant ? 'Assistant(tool_calls)' : (roleLabels[msg.role] || msg.role)
            const summary = isToolCallAssistant ? `${msg.tool_calls!.length} tool_calls` : `${msg.content.length} chars`
            const expandedContent = isToolCallAssistant
              ? JSON.stringify(msg.tool_calls, null, 2)
              : msg.content

            return (
              <div key={idx} style={styles.messageCard}>
                <button
                  style={styles.messageHeader}
                  onClick={() => toggleExpand(idx)}
                >
                  <div style={styles.messageHeaderLeft}>
                    <span style={{
                      ...styles.roleBadge,
                      background: roleColors[msg.role] || '#666',
                    }}>
                      {label}
                    </span>
                    <span style={styles.charCount}>
                      {summary}
                    </span>
                  </div>
                  <svg
                    width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="var(--color-text-muted)" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{
                      transform: expandedIdx === idx ? 'rotate(180deg)' : 'rotate(0deg)',
                      transition: 'transform 0.2s',
                    }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {expandedIdx === idx && (
                  <pre style={styles.messageContent}>
                    {expandedContent}
                  </pre>
                )}
              </div>
            )
          })}
        </div>

        {/* Refresh button */}
        {data && (
          <div style={styles.footer}>
            <button style={styles.refreshBtn} onClick={loadContext} disabled={loading}>
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'rgba(0,0,0,0.5)',
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#1E1E2E',
    animation: 'fadeIn 0.2s ease',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  headerIcon: {
    fontSize: 16,
    fontWeight: 700,
    color: '#8B5CF6',
    fontFamily: 'monospace',
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#E2E8F0',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#94A3B8',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: {
    display: 'flex',
    gap: 8,
    padding: '8px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  metaTag: {
    fontSize: 11,
    color: '#94A3B8',
    background: 'rgba(255,255,255,0.06)',
    padding: '3px 8px',
    borderRadius: 4,
    fontFamily: 'monospace',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
  },
  status: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 14,
    padding: 24,
  },
  messageCard: {
    marginBottom: 6,
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  messageHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.03)',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
  },
  messageHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  roleBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: '#fff',
    padding: '2px 8px',
    borderRadius: 4,
  },
  charCount: {
    fontSize: 11,
    color: '#64748B',
    fontFamily: 'monospace',
  },
  messageContent: {
    margin: 0,
    padding: '12px',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#CBD5E1',
    background: 'rgba(0,0,0,0.2)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '60vh',
    overflowY: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  footer: {
    padding: '8px 16px 12px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    flexShrink: 0,
  },
  refreshBtn: {
    width: '100%',
    padding: '8px 16px',
    borderRadius: 6,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.06)',
    color: '#CBD5E1',
    fontSize: 13,
    cursor: 'pointer',
    transition: 'background 0.2s',
  },
}
