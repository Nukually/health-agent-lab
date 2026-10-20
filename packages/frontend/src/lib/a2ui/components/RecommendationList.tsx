/**
 * RecommendationList —— 多条建议合并为勾选列表
 *
 * priority 决定图标色：high→红点、normal→橙勾、low→灰圈
 */

import type { ReactNode } from 'react'
import A2uiMarkdown, { type CitationSource } from '../markdown.js'
import { parseA2ui } from '../parser.js'

type Priority = 'high' | 'normal' | 'low'

export interface RecommendationItemData {
  priority: Priority | string
  inner: string
  incomplete?: boolean
}

interface Props {
  items: RecommendationItemData[]
  renderResource?: (id: string) => ReactNode
  citationSources?: CitationSource[]
}

function Icon({ priority }: { priority: Priority }) {
  if (priority === 'high') {
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: '#D94848',
          flexShrink: 0,
          marginTop: 7,
        }}
      />
    )
  }
  if (priority === 'low') {
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 10,
          height: 10,
          borderRadius: '50%',
          border: '1.5px solid #B8B8B8',
          flexShrink: 0,
          marginTop: 7,
        }}
      />
    )
  }
  // normal
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#D4876C"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, marginTop: 4 }}
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

const labelMap: Record<Priority, string> = {
  high: '紧急',
  normal: '建议',
  low: '可选',
}

export default function RecommendationList({ items, renderResource, citationSources }: Props) {
  return (
    <ul
      style={{
        listStyle: 'none',
        padding: 0,
        margin: '8px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {items.map((item, idx) => {
        const p: Priority = item.priority === 'high' || item.priority === 'low' ? item.priority : 'normal'
        return (
          <li
            key={idx}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              minHeight: 36,
              fontSize: 'var(--font-size-chat)',
              lineHeight: 1.6,
              color: 'var(--color-text)',
            }}
          >
            <Icon priority={p} />
            <div style={{ flex: 1, wordBreak: 'break-word' }}>
              {p === 'high' && (
                <span
                  style={{
                    display: 'inline-block',
                    fontSize: 'calc(var(--font-size-chat) - 3px)',
                    color: '#8A1F1F',
                    background: '#FEE2E2',
                    padding: '1px 6px',
                    borderRadius: 8,
                    marginBottom: 6,
                    fontWeight: 600,
                  }}
                >
                  {labelMap[p]}
                </span>
              )}
              <div>
                <RecommendationInner content={item.inner} renderResource={renderResource} citationSources={citationSources} />
                {item.incomplete && (
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
          </li>
        )
      })}
    </ul>
  )
}

function RecommendationInner({
  content,
  renderResource,
  citationSources,
}: {
  content: string
  renderResource?: (id: string) => ReactNode
  citationSources?: CitationSource[]
}) {
  if (!renderResource || !content.includes('<resource_ref')) {
    return <A2uiMarkdown content={content} citationSources={citationSources} />
  }

  const renderResourceNode = renderResource
  const segments = parseA2ui(content)

  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.type === 'markdown') {
          return <A2uiMarkdown key={`md-${idx}`} content={seg.text} citationSources={citationSources} />
        }
        if (seg.name === 'resource_ref') {
          const id = seg.attrs.id?.trim()
          const node = id ? renderResourceNode(id) : null
          return node ? (
            <div key={`resource-${id}-${idx}`} style={{ marginTop: 8 }}>
              {node}
            </div>
          ) : null
        }
        return seg.inner
          ? <A2uiMarkdown key={`tag-${idx}`} content={seg.inner} citationSources={citationSources} />
          : null
      })}
    </>
  )
}
