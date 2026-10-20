/**
 * A2UI 标签解析器
 *
 * 输入：final_answer 之后的原始字符串（可能含 A2UI 标签，也可能完全没有）。
 * 输出：Segment[]，顺序保留；tag 段之外的一律为 markdown 段。
 *
 * 流式安全：当 streaming=true 时，若字符串末尾出现"已知标签的未闭合部分"
 *         （半开的 <red_flag，或开了但还没见到 </red_flag>），截断之后的部分
 *         不参与渲染——等下一次 content 更新再解析。视觉效果：tag 内容整块出现。
 *
 * 未知/畸形标签：按普通文本透传到 markdown 段，再由 A2uiMarkdown 剥掉标签字面量；
 *         合法 A2UI 标签不会进入这条路径，仍按组件渲染。
 */

import { A2UI_TAGS, A2UI_TAG_NAMES, type A2uiTagName } from '@health-agent/shared'

export type Segment =
  | { type: 'markdown'; text: string }
  | {
      type: 'tag'
      name: A2uiTagName
      attrs: Record<string, string>
      inner: string
      selfClosing: boolean
      /** 流式态下：open 已到但 close 还没到，inner 仍会继续增长 */
      incomplete?: boolean
    }

const TAGS_ALT = A2UI_TAG_NAMES.join('|')
const ATTR_VALUE_PATTERN = `"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|[^\\s/>]+`
const ATTRS_PATTERN = `(?:\\s+[a-zA-Z_][\\w-]*\\s*=\\s*(?:${ATTR_VALUE_PATTERN}))*`

/** 匹配一个完整的已知标签（自闭合或成对）。每次新建避免 lastIndex 状态污染。 */
function buildTagRegex(): RegExp {
  return new RegExp(
    `<(${TAGS_ALT})(${ATTRS_PATTERN})\\s*(\\/>|>([\\s\\S]*?)<\\/\\1>)`,
    'g',
  )
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|([^\s/>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? ''
  }
  return out
}

/**
 * 流式态下仅截断"末尾半个 open/close 标签"（如 `<red_fl` / `</conclu` 未到 `>`），
 * 避免裸 XML 字面量漏到用户眼前。中间出现的"已 open 未 close"交给 parseA2ui 主流程
 * emit 成 incomplete 的 tag segment，让组件提前挂载、inner 随流增长。
 */
function trimTrailingPartialTag(content: string): string {
  const lastLt = content.lastIndexOf('<')
  if (lastLt < 0) return content
  const tail = content.slice(lastLt)
  if (tail.includes('>')) return content
  for (const name of A2UI_TAG_NAMES) {
    const full = `<${name}`
    const closeFull = `</${name}`
    if (full.startsWith(tail) || tail.startsWith(full)) return content.slice(0, lastLt)
    if (closeFull.startsWith(tail) || tail.startsWith(closeFull)) return content.slice(0, lastLt)
  }
  return content
}

/** 在 tail 中找第一个"已开未闭"的已知开标签，返回切分信息。null 表示没有。 */
function findTrailingUnclosedOpen(
  tail: string,
): { prefix: string; name: A2uiTagName; attrs: Record<string, string>; inner: string } | null {
  const openRe = new RegExp(
    `<(${TAGS_ALT})(${ATTRS_PATTERN})\\s*>`,
    'g',
  )
  const m = openRe.exec(tail)
  if (!m) return null
  const name = m[1] as A2uiTagName
  return {
    prefix: tail.slice(0, m.index),
    name,
    attrs: parseAttrs(m[2] || ''),
    inner: tail.slice(m.index + m[0].length),
  }
}

export function parseA2ui(content: string, streaming = false): Segment[] {
  if (!content) return []
  const src = streaming ? trimTrailingPartialTag(content) : content
  const segments: Segment[] = []
  const re = buildTagRegex()
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m.index > cursor) {
      const text = src.slice(cursor, m.index)
      if (text) segments.push({ type: 'markdown', text })
    }
    const name = m[1] as A2uiTagName
    const attrs = parseAttrs(m[2] || '')
    const selfClosing = m[3] === '/>'
    const inner = selfClosing ? '' : (m[4] ?? '')
    if (A2UI_TAGS[name]) {
      segments.push({ type: 'tag', name, attrs, inner, selfClosing })
    } else {
      segments.push({ type: 'markdown', text: m[0] })
    }
    cursor = m.index + m[0].length
  }
  // 尾部残余：流式态下优先识别"已开未闭"标签，emit 成 incomplete segment
  if (cursor < src.length) {
    const tail = src.slice(cursor)
    if (streaming) {
      const partial = findTrailingUnclosedOpen(tail)
      if (partial && A2UI_TAGS[partial.name]) {
        if (partial.prefix) segments.push({ type: 'markdown', text: partial.prefix })
        segments.push({
          type: 'tag',
          name: partial.name,
          attrs: partial.attrs,
          inner: partial.inner,
          selfClosing: false,
          incomplete: true,
        })
        return segments
      }
    }
    segments.push({ type: 'markdown', text: tail })
  }
  return segments
}
