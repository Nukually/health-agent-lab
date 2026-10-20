/**
 * 剥离需求确认答案里附带的 `（ref_id: x）` 标注。
 * ref_id 需保留在消息正文里供 AI 识别所选资源，但用户气泡/复制时不展示。
 */
export function stripRefIdAnnotation(text: string): string {
  return text.replace(/（\s*ref_id\s*:[^）]*）/g, '')
}

/** 去除模型偶发漏出的 <final_answer> / <response> 标签字面量（开闭均剥离） */
export function stripAnswerTags(text: string): string {
  return text.replace(/<\/?final_answer>/g, '').replace(/<\/?response>/g, '')
}

/** 复制给用户时剥掉内部渲染协议标签，保留可读正文。 */
export function toAssistantClipboardText(text: string): string {
  return stripXmlLikeTags(
    stripAnswerTags(text)
      .replace(/<recommendation\b[^>]*>([\s\S]*?)<\/recommendation>/gi, '$1')
      .replace(/<conclusion\b[^>]*>([\s\S]*?)<\/conclusion>/gi, '$1')
      .replace(/<red_flag\b[^>]*>([\s\S]*?)<\/red_flag>/gi, '$1')
      .replace(/<metric\b([^>]*)\/>/gi, (_, attrs: string) => metricAttrsToText(attrs))
      .replace(/<metric\b([^>]*)>[\s\S]*?<\/metric>/gi, (_, attrs: string) => metricAttrsToText(attrs))
      .replace(/<reference\b[^>]*\/>/gi, '')
      .replace(/<reference\b[^>]*>[\s\S]*?<\/reference>/gi, ''),
  ).trim()
}

function metricAttrsToText(attrs: string): string {
  const parsed = parseXmlAttrs(attrs)
  return [parsed.label, parsed.value, parsed.unit]
    .filter((item) => item?.trim())
    .join(' ')
}

function parseXmlAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|([^\s/>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrs))) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? ''
  }
  return out
}

function stripXmlLikeTags(text: string): string {
  return text.replace(
    /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|[^\s"'=<>`]+))?)*\s*\/?>/g,
    '',
  )
}
