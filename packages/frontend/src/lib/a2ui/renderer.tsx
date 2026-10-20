/**
 * A2uiRenderer —— A2UI 消息统一渲染入口
 *
 * 把 content 字符串解析为 Segment[]，按顺序渲染：
 *   - markdown 段 → ReactMarkdown + remarkGfm（复用原有行为）
 *   - tag 段 → 对应语义组件
 *
 * 策略：相邻的 recommendation 合并为单一勾选列表；相邻的 metric 合并为单行徽章带。
 */

import { parseA2ui, type Segment } from './parser.js'
import RedFlagCard from './components/RedFlagCard.js'
import ConclusionCard from './components/ConclusionCard.js'
import RecommendationList, { type RecommendationItemData } from './components/RecommendationList.js'
import MetricBadge from './components/MetricBadge.js'
import A2uiMarkdown, { type CitationSource } from './markdown.js'

export default function A2uiRenderer({
  content,
  streaming = false,
  renderResource,
  citationSources,
}: {
  content: string
  streaming?: boolean
  renderResource?: (id: string) => React.ReactNode
  citationSources?: CitationSource[]
}) {
  const segments = parseA2ui(stripLegacyReferenceTags(content), streaming)
  const nodes: React.ReactNode[] = []
  let i = 0
  while (i < segments.length) {
    const seg = segments[i]
    if (seg.type === 'markdown') {
      nodes.push(
        <A2uiMarkdown key={`md-${i}`} content={seg.text} citationSources={citationSources} />,
      )
      i++
      continue
    }
    // tag 段
    if (seg.name === 'recommendation') {
      const items: RecommendationItemData[] = []
      const startIdx = i
      while (i < segments.length) {
        const s = segments[i]
        if (s.type === 'tag' && s.name === 'recommendation') {
          items.push({ priority: s.attrs.priority || 'normal', inner: s.inner, incomplete: s.incomplete })
          i++
          continue
        }
        if (s.type === 'markdown' && !s.text.trim()) {
          i++
          continue
        }
        break
      }
      nodes.push(
        <RecommendationList
          key={`rec-${startIdx}`}
          items={items}
          renderResource={renderResource}
          citationSources={citationSources}
        />,
      )
      continue
    }
    if (seg.name === 'metric') {
      const metrics: Array<Record<string, string>> = []
      const startIdx = i
      while (i < segments.length) {
        const s = segments[i]
        if (s.type === 'tag' && s.name === 'metric') {
          metrics.push(s.attrs)
          i++
          continue
        }
        if (s.type === 'markdown' && !s.text.trim()) {
          i++
          continue
        }
        break
      }
      nodes.push(
        <div
          key={`mrow-${startIdx}`}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}
        >
          {metrics.map((attrs, j) => (
            <MetricBadge
              key={j}
              label={attrs.label}
              value={attrs.value}
              unit={attrs.unit}
              status={attrs.status}
            />
          ))}
        </div>,
      )
      continue
    }
    if (seg.name === 'red_flag') {
      const level = seg.attrs.level === 'warning' ? 'warning' : 'urgent'
      nodes.push(
        <RedFlagCard key={`rf-${i}`} level={level} inner={seg.inner} incomplete={seg.incomplete} citationSources={citationSources} />,
      )
      i++
      continue
    }
    if (seg.name === 'conclusion') {
      nodes.push(
        <ConclusionCard key={`cc-${i}`} inner={seg.inner} incomplete={seg.incomplete} citationSources={citationSources} />,
      )
      i++
      continue
    }
    if (seg.name === 'resource_ref') {
      const id = seg.attrs.id?.trim()
      if (id && renderResource) {
        const node = renderResource(id)
        if (node) nodes.push(<div key={`resource-${id}-${i}`}>{node}</div>)
      }
      i++
      continue
    }
    // 理论不可达：任何 tag 都会命中上面分支；兜底透传
    i++
  }
  return <>{nodes}</>
}

function stripLegacyReferenceTags(content: string): string {
  return content
    .replace(/<reference\b[^>]*\/>/gi, '')
    .replace(/<reference\b[^>]*>[\s\S]*?<\/reference>/gi, '')
}

export { parseA2ui } from './parser.js'
export type { Segment } from './parser.js'
