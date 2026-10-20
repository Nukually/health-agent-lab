/**
 * RedFlagCard —— 红旗就医警告卡
 *
 * 模型输出 <red_flag level="urgent|warning">文本</red_flag> 时渲染。
 * 视觉最醒目：红色左边框 + 图标 + 一次性 2s 呼吸阴影。
 */

import { useEffect, useState } from 'react'
import A2uiMarkdown, { type CitationSource } from '../markdown.js'

type Level = 'urgent' | 'warning'

export default function RedFlagCard({
  level = 'urgent',
  inner,
  incomplete,
  citationSources,
}: {
  level?: Level
  inner: string
  incomplete?: boolean
  citationSources?: CitationSource[]
}) {
  const [breathe, setBreathe] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setBreathe(false), 2000)
    return () => clearTimeout(t)
  }, [])

  const isUrgent = level === 'urgent'
  const palette = isUrgent
    ? { bg: '#FFF2F0', border: '#D94848', text: '#8A1F1F', badge: '立即就医' }
    : { bg: '#FFF5E6', border: '#D97706', text: '#7A3D00', badge: '注意' }

  const icon = isUrgent ? '🚨' : '⚠️'

  return (
    <div
      role="alert"
      aria-label={isUrgent ? '紧急就医提示' : '警示提示'}
      style={{
        background: palette.bg,
        borderLeft: `4px solid ${palette.border}`,
        borderRadius: 10,
        padding: '14px 16px',
        margin: '10px 0',
        color: palette.text,
        boxShadow: breathe ? `0 0 0 4px ${palette.border}22, 0 2px 8px ${palette.border}33` : 'none',
        transition: 'box-shadow 0.8s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.2,
            background: palette.border,
            color: '#fff',
            padding: '2px 8px',
            borderRadius: 10,
          }}
        >
          {palette.badge}
        </span>
      </div>
      <div style={{ fontSize: 'var(--font-size-chat)', fontWeight: 600, lineHeight: 1.6, wordBreak: 'break-word' }}>
        <A2uiMarkdown content={inner} citationSources={citationSources} />
        {incomplete && (
          <span
            style={{
              display: 'inline-block',
              marginLeft: 2,
              animation: 'blink 1s step-end infinite',
              opacity: 0.6,
            }}
          >
            ▊
          </span>
        )}
      </div>
    </div>
  )
}
