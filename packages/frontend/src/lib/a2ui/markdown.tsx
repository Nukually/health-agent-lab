import { Children, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MedicalLiteratureSource } from '@health-agent/shared'
import { stripInvalidXmlLikeTags } from './sanitize.js'
import MedicalLiteratureSourceDialog from './components/MedicalLiteratureSourceDialog.js'

// remark-gfm 的 autolink regex 使用 lookbehind；旧 Safari / 旧 WebView 不支持时会在渲染消息时抛 SyntaxError。
// 用能力检测替代 UA 判断，避免 iOS 14.4 等版本进入 /chat 后白屏。
const ENABLE_REMARK_GFM = supportsRemarkGfmAutolinkRegex()

export type CitationSource = MedicalLiteratureSource

function safeUrlTransform(url: string): string {
  const lower = url.trim().toLowerCase()
  if (lower.startsWith('citation:')) return url
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('/') ||
    lower.startsWith('#')
  ) {
    return url
  }
  return ''
}

function injectCitationLinks(
  content: string,
  sourceByCitationId: Map<string, CitationSource>,
): string {
  if (sourceByCitationId.size === 0) return content
  return content.replace(/\[((?:d-\d+-\d+)|(?:\d+))\](?!\()/gi, (match, rawId: string) => {
    const id = rawId.toLowerCase()
    if (!sourceByCitationId.has(id)) return match
    return `[${id}](citation:${id})`
  })
}

function buildMarkdownComponents(
  sourceByCitationId: Map<string, CitationSource>,
  onCitationClick: (source: CitationSource) => void,
  onInternalNavigate: (path: string) => void,
): Components {
  return {
    a(props) {
      const { href, children, ...rest } = props
      if (typeof href === 'string' && href.startsWith('citation:')) {
        const citationId = href.slice('citation:'.length).toLowerCase()
        const source = sourceByCitationId.get(citationId)
        if (!source) return <>{children}</>
        return (
          <button
            type="button"
            onClick={() => onCitationClick(source)}
            style={citationStyles.button}
            aria-label={`查看引用 ${citationId}`}
          >
            [{citationId}]
          </button>
        )
      }

      // 站内路由链接（/xxx）走 SPA 导航：target="_blank" 在原生 WebView 里需要宿主实现
      // 新窗口回调，iOS/Android/Harmony 三端都没实现，会被静默丢弃导致点击无反应。
      if (typeof href === 'string' && href.startsWith('/')) {
        return (
          <a
            {...rest}
            href={href}
            onClick={(e) => {
              // 保留 H5 上修饰键/中键的新标签页行为
              if (
                e.defaultPrevented ||
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey ||
                e.button !== 0
              ) {
                return
              }
              e.preventDefault()
              onInternalNavigate(href)
            }}
            style={linkStyle}
          >
            {children}
          </a>
        )
      }

      return (
        <a {...rest} href={href} target="_blank" rel="noreferrer" style={linkStyle}>
          {children}
        </a>
      )
    },
    tr(props) {
      const { children, ...rest } = props
      const cells = Children.toArray(children).filter(
        (c): c is React.ReactElement => typeof c === 'object' && c !== null && 'props' in c,
      )
      const allEmpty =
        cells.length > 0 &&
        cells.every((c) => {
          const inner = Children.toArray((c.props as { children?: React.ReactNode }).children)
          return inner.length === 0 || inner.every((t) => typeof t === 'string' && !t.trim())
        })
      if (allEmpty) return null
      return <tr {...rest}>{children}</tr>
    },
  }
}

export default function A2uiMarkdown({
  content,
  citationSources,
}: {
  content: string
  citationSources?: CitationSource[]
}) {
  const [activeSource, setActiveSource] = useState<CitationSource | null>(null)
  const navigate = useNavigate()
  const sanitizedContent = stripInvalidXmlLikeTags(content)
  const sourceByCitationId = useMemo(() => {
    const map = new Map<string, CitationSource>()
    for (const source of citationSources ?? []) {
      map.set(source.id.toLowerCase(), source)
    }
    return map
  }, [citationSources])
  const renderedContent = useMemo(
    () => injectCitationLinks(sanitizedContent, sourceByCitationId),
    [sanitizedContent, sourceByCitationId],
  )
  const components = useMemo(
    () => buildMarkdownComponents(sourceByCitationId, setActiveSource, navigate),
    [sourceByCitationId, navigate],
  )
  if (!sanitizedContent) return null

  return (
    <>
      <ReactMarkdown
        remarkPlugins={ENABLE_REMARK_GFM ? [remarkGfm] : []}
        components={components}
        urlTransform={safeUrlTransform}
      >
        {renderedContent}
      </ReactMarkdown>
      <MedicalLiteratureSourceDialog
        source={activeSource}
        onClose={() => setActiveSource(null)}
      />
    </>
  )
}

function supportsRemarkGfmAutolinkRegex(): boolean {
  try {
    new RegExp('(?<=^|\\s|\\p{P}|\\p{S})x', 'gu')
    return true
  } catch {
    return false
  }
}

const linkStyle: React.CSSProperties = {
  color: 'var(--color-primary)',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
  fontWeight: 600,
}

const citationStyles: Record<string, React.CSSProperties> = {
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    verticalAlign: 'baseline',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-primary-dark)',
    fontSize: '0.9em',
    lineHeight: 1,
    fontWeight: 800,
    padding: '0 3px',
    cursor: 'pointer',
    textDecoration: 'none',
  },
}
