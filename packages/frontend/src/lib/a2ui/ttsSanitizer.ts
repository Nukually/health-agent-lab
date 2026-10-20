/**
 * TTS 流式标签过滤器
 *
 * 输入：`<final_answer>` 之后的文本 delta（可能跨 chunk 切半个标签）。
 * 输出：拿去喂给火山 TTS 的"干净文本"——不会包含任何 A2UI 标签字面量；
 *       对于 skip-all 策略的标签（red_flag / metric / reference），连内部文本也不输出；
 *       对于 speak-inner 策略的标签（conclusion / recommendation），只剥掉标签本身保留文本。
 *       同时兼容剥离 `<final_answer>` / `</final_answer>`（按 speak-inner 语义处理）。
 *
 * 用法（配合 useTTSPlayer）：
 *   const stripper = new TtsTagStripper()
 *   const safe = stripper.feed(delta)
 *   if (safe) ws.send(safe)
 *   // 流结束时：
 *   const tail = stripper.flushFinal()
 *   if (tail) ws.send(tail)
 *   stripper.reset()
 *
 * 设计要点：
 * - 只信赖标签名白名单（A2UI_TAGS + final_answer），其他 '<...>' 当普通文本
 * - 跨 chunk 安全：buffer 尾部若是已知标签的前缀/未闭合标签，保留到下一次 feed
 * - skip-all 内没见到闭合就到流结束：整段丢弃（模型漏闭合不应泄漏到 TTS）
 * - speak-inner 内没见到闭合就到流结束：flushFinal 时把残余当作正文输出
 */

import {
  A2UI_TAGS,
  A2UI_TAG_NAMES,
  type A2uiTagDef,
  type A2uiTagName,
  type A2uiTtsPolicy,
} from '@health-agent/shared'

type KnownTag = A2uiTagName | 'final_answer' | 'response'

interface TagDef {
  name: KnownTag
  ttsPolicy: A2uiTtsPolicy
  speakFromAttrs?: (attrs: Record<string, string>) => string
}

const TAG_DEFS: Record<KnownTag, TagDef> = {
  ...(Object.fromEntries(
    A2UI_TAG_NAMES.map((n) => {
      const def = A2UI_TAGS[n] as A2uiTagDef
      return [n, { name: n, ttsPolicy: def.ttsPolicy, speakFromAttrs: def.speakFromAttrs }]
    }),
  ) as Record<A2uiTagName, TagDef>),
  final_answer: { name: 'final_answer', ttsPolicy: 'speak-inner' },
  response: { name: 'response', ttsPolicy: 'speak-inner' },
}

const KNOWN_NAMES: KnownTag[] = Object.keys(TAG_DEFS) as KnownTag[]
const TAGS_ALT = KNOWN_NAMES.join('|')
const ATTR_VALUE_PATTERN = `"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|[^\\s/>]+`
const ATTRS_PATTERN = `(?:\\s+[a-zA-Z_][\\w-]*\\s*=\\s*(?:${ATTR_VALUE_PATTERN}))*`

export class TtsTagStripper {
  private buffer = ''
  /** 处于某个 skip-all 标签内：需要丢弃直到看到 close tag */
  private skipUntil: string | null = null
  /** 处于某个 speak-inner 标签内：需要吃掉 close tag 本身 */
  private innerCloseNeeded: string | null = null

  feed(delta: string): string {
    if (!delta) return ''
    this.buffer += delta
    return this.process()
  }

  /** 流结束时调用：输出尚未 flush 的残余（仅对 speak-inner / 正文有效，skip-all 残余丢弃） */
  flushFinal(): string {
    if (this.skipUntil) {
      this.buffer = ''
      this.skipUntil = null
      return ''
    }
    const out = this.buffer
    this.buffer = ''
    this.innerCloseNeeded = null
    return out
  }

  reset() {
    this.buffer = ''
    this.skipUntil = null
    this.innerCloseNeeded = null
  }

  private process(): string {
    let out = ''
    // 主循环：每次迭代处理一次状态转移
    // 退出条件：buffer 里不能再安全消耗（需要等下一次 feed）
    while (true) {
      // 情况 1：正处于 skip-all 标签内，找闭合
      if (this.skipUntil) {
        const idx = this.buffer.indexOf(this.skipUntil)
        if (idx < 0) {
          // 还没见到闭合：buffer 里的内容都不能输出，但也不能无限累积
          // 保留最后 (closeTag.length - 1) 字节以防 close 跨 chunk 切半
          const keep = Math.min(this.skipUntil.length - 1, this.buffer.length)
          this.buffer = this.buffer.slice(this.buffer.length - keep)
          return out
        }
        // 找到闭合：丢弃所有直到 close 含本身
        this.buffer = this.buffer.slice(idx + this.skipUntil.length)
        this.skipUntil = null
        continue
      }

      // 情况 2：正处于 speak-inner 标签内，输出内部文本直到 close
      if (this.innerCloseNeeded) {
        const close = this.innerCloseNeeded
        const idx = this.buffer.indexOf(close)
        if (idx < 0) {
          // 还没见到闭合：输出 buffer，但尾部若是 close 标签的部分前缀需保留
          const safe = safePrefixBeforeCloseHint(this.buffer, close)
          out += this.buffer.slice(0, safe)
          this.buffer = this.buffer.slice(safe)
          return out
        }
        // 找到闭合：输出到闭合前，吃掉闭合本身
        out += this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + close.length)
        this.innerCloseNeeded = null
        continue
      }

      // 情况 3：处于正文，找下一个已知标签事件（开 / 孤立闭 / 半标签）
      const tagMatch = findNextKnownTag(this.buffer)
      if (tagMatch.kind === 'none') {
        const safe = safePrefixBeforeOpenHint(this.buffer)
        out += this.buffer.slice(0, safe)
        this.buffer = this.buffer.slice(safe)
        return out
      }
      if (tagMatch.kind === 'partial') {
        out += this.buffer.slice(0, tagMatch.index)
        this.buffer = this.buffer.slice(tagMatch.index)
        return out
      }
      if (tagMatch.kind === 'close') {
        // 孤立闭合标签（没有对应开标签）：输出它之前的正文，剥掉闭合本身
        out += this.buffer.slice(0, tagMatch.index)
        this.buffer = this.buffer.slice(tagMatch.index + tagMatch.length)
        continue
      }
      // kind === 'open'
      out += this.buffer.slice(0, tagMatch.index)
      this.buffer = this.buffer.slice(tagMatch.index + tagMatch.length)
      const def = TAG_DEFS[tagMatch.name]
      if (tagMatch.selfClose) {
        // 自闭合标签：speak-inner + speakFromAttrs 则合成一句话；否则什么都不输出
        if (def.ttsPolicy === 'speak-inner' && def.speakFromAttrs) {
          const spoken = def.speakFromAttrs(tagMatch.attrs)
          if (spoken) out += spoken
        }
        continue
      }
      if (def.ttsPolicy === 'skip-all') {
        this.skipUntil = `</${def.name}>`
      } else {
        this.innerCloseNeeded = `</${def.name}>`
      }
    }
  }
}

/**
 * 寻找 buffer 中下一个已知 tag 事件。返回四种 kind：
 *  - 'open' : 找到完整开标签（含自闭合），index 为起点
 *  - 'close': 找到孤立完整闭合标签（情况 3 入口时 innerCloseNeeded 为 null 意味着它没有对应的开）
 *  - 'partial': buffer 末尾可能是已知标签（开/闭）的前缀，保留到下一次 feed
 *  - 'none' : 没有任何匹配
 * 若 'open' 与 'close' 同时存在，取 index 更小者（即文本中更靠前的）。
 */
function findNextKnownTag(text: string):
  | {
      kind: 'open'
      index: number
      length: number
      name: KnownTag
      selfClose: boolean
      attrs: Record<string, string>
    }
  | { kind: 'close'; index: number; length: number; name: KnownTag }
  | { kind: 'partial'; index: number }
  | { kind: 'none' } {
  const openRe = new RegExp(`<(${TAGS_ALT})(${ATTRS_PATTERN})\\s*(\\/?)>`, 'g')
  const closeRe = new RegExp(`</(${TAGS_ALT})>`, 'g')
  const openM = openRe.exec(text)
  const closeM = closeRe.exec(text)

  const preferOpen =
    openM !== null && (closeM === null || openM.index <= closeM.index)
  const preferClose =
    closeM !== null && (openM === null || closeM.index < openM.index)

  if (preferOpen && openM) {
    return {
      kind: 'open',
      index: openM.index,
      length: openM[0].length,
      name: openM[1] as KnownTag,
      selfClose: openM[3] === '/',
      attrs: parseAttrs(openM[2] ?? ''),
    }
  }
  if (preferClose && closeM) {
    return {
      kind: 'close',
      index: closeM.index,
      length: closeM[0].length,
      name: closeM[1] as KnownTag,
    }
  }
  // 若没找到任何完整标签，检查末尾是否有已知标签的半开/半闭前缀
  const lastLt = text.lastIndexOf('<')
  if (lastLt < 0) return { kind: 'none' }
  const tail = text.slice(lastLt)
  if (!tail.includes('>')) {
    for (const name of KNOWN_NAMES) {
      const open = `<${name}`
      const close = `</${name}`
      if (open.startsWith(tail) || tail.startsWith(open)) return { kind: 'partial', index: lastLt }
      if (close.startsWith(tail) || tail.startsWith(close)) return { kind: 'partial', index: lastLt }
    }
  }
  return { kind: 'none' }
}

function safePrefixBeforeOpenHint(text: string): number {
  const lastLt = text.lastIndexOf('<')
  if (lastLt < 0) return text.length
  const tail = text.slice(lastLt)
  if (tail.includes('>')) return text.length
  for (const name of KNOWN_NAMES) {
    const open = `<${name}`
    const close = `</${name}`
    if (open.startsWith(tail) || tail.startsWith(open)) return lastLt
    if (close.startsWith(tail) || tail.startsWith(close)) return lastLt
  }
  return text.length
}

function parseAttrs(attrsStr: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|([^\s/>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrsStr))) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? ''
  return out
}

function safePrefixBeforeCloseHint(text: string, closeTag: string): number {
  // buffer 末尾可能是 closeTag 的前缀（比如 "..abc</red_"），保留等下一次 feed
  for (let n = Math.min(closeTag.length - 1, text.length); n > 0; n--) {
    if (text.slice(text.length - n) === closeTag.slice(0, n)) {
      return text.length - n
    }
  }
  return text.length
}
