/**
 * ConclusionCard —— 一句话结论高亮卡
 *
 * 左侧主题橙色边条，背景浅橙，字号比正文大一号加中粗。
 */

import A2uiMarkdown, { type CitationSource } from '../markdown.js'

export default function ConclusionCard({
  inner,
  incomplete,
  citationSources,
}: {
  inner: string
  incomplete?: boolean
  citationSources?: CitationSource[]
}) {
  return (
    <div
      style={{
        borderLeft: '3px solid #D4876C',
        background: 'rgba(255, 245, 238, 0.55)',
        borderRadius: 8,
        padding: '10px 14px',
        margin: '10px 0',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: '#B36B4E',
          fontWeight: 600,
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        结论
      </div>
      <div
        style={{
          fontSize: 'calc(var(--font-size-chat) + 1px)',
          fontWeight: 500,
          lineHeight: 1.6,
          color: 'var(--color-text)',
          wordBreak: 'break-word',
        }}
      >
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
