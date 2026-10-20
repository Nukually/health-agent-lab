/**
 * TTS 流式 Markdown 剥离器
 *
 * 模型习惯在答复里用 **加粗** / *斜体* / `code` / # 标题 / - 列表 标注。
 * 这些记号喂给火山 TTS 会被当字面量念出来（"星星"、"井号"等），体验差。
 *
 * 挂在 TtsTagStripper 之后，再从 delta 流里把 markdown 记号剥干净。
 *
 * 流式安全：遇到"当前 buffer 里存在未闭合配对记号"（奇数个 **、奇数个 *、
 *   奇数个 `、[ 多于 ]）时，从最早的那个未闭合位置往后全部暂留，等下一次 feed
 *   再处理。其余部分跑 stripAll 正则替换后输出。
 */

export class TtsMarkdownStripper {
  private buffer = ''

  feed(delta: string): string {
    if (!delta) return ''
    this.buffer += delta
    return this.flushSafe()
  }

  flushFinal(): string {
    const out = stripAll(this.buffer)
    this.buffer = ''
    return out
  }

  reset() {
    this.buffer = ''
  }

  private flushSafe(): string {
    const cutoff = findSafeSplit(this.buffer)
    if (cutoff <= 0) return ''
    const head = this.buffer.slice(0, cutoff)
    this.buffer = this.buffer.slice(cutoff)
    return stripAll(head)
  }
}

/** 返回可安全 emit 的前缀长度；cutoff 之后的内容留到下一次 feed。 */
function findSafeSplit(text: string): number {
  let cutoff = text.length

  // **pair**
  const doubleStars: number[] = []
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '*' && text[i + 1] === '*') {
      doubleStars.push(i)
      i++ // 跳过下一个 *，不重复计数
    }
  }
  if (doubleStars.length % 2 === 1) {
    cutoff = Math.min(cutoff, doubleStars[doubleStars.length - 1])
  }

  // 单 *（排除 ** 的组成部分）
  const singleStars: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '*') continue
    const prev = text[i - 1]
    const next = text[i + 1]
    if (prev === '*' || next === '*') continue
    singleStars.push(i)
  }
  if (singleStars.length % 2 === 1) {
    cutoff = Math.min(cutoff, singleStars[singleStars.length - 1])
  }

  // 反引号
  const backticks: number[] = []
  for (let i = 0; i < text.length; i++) if (text[i] === '`') backticks.push(i)
  if (backticks.length % 2 === 1) {
    cutoff = Math.min(cutoff, backticks[backticks.length - 1])
  }

  // [ 未闭合
  const lastOpenBr = text.lastIndexOf('[')
  const lastCloseBr = text.lastIndexOf(']')
  if (lastOpenBr > lastCloseBr && lastOpenBr < cutoff) cutoff = lastOpenBr

  // 末尾是单个 *、`、_（下一 chunk 可能把它拼成 **、双 _）：退一步
  if (cutoff === text.length && text.length > 0) {
    const last = text[text.length - 1]
    if (last === '*' || last === '_' || last === '`' || last === '[') cutoff = text.length - 1
  }

  return cutoff
}

/** 对一段"不含未闭合配对记号"的文本做 markdown → 纯文本的规则替换。 */
function stripAll(text: string): string {
  if (!text) return ''
  let out = text

  // 粗体 / 斜体 / 代码 / 链接
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, '$1')
  out = out.replace(/__([\s\S]+?)__/g, '$1')
  out = out.replace(/(^|[^*\w])\*([^\s*][\s\S]*?)\*(?!\*)/g, '$1$2')
  out = out.replace(/(^|[^_\w])_([^\s_][\s\S]*?)_(?!_)/g, '$1$2')
  out = out.replace(/`([^`]+)`/g, '$1')
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // 链接 → 文本

  // 行首记号
  out = out.replace(/^#{1,6}\s+/gm, '')           // 标题
  out = out.replace(/^\s*>\s?/gm, '')             // 引用
  out = out.replace(/^\s*[-*+]\s+/gm, '')         // 无序列表
  out = out.replace(/^\s*\d+\.\s+/gm, '')         // 有序列表
  out = out.replace(/^\s*-{3,}\s*$/gm, '')        // 分割线

  return out
}
