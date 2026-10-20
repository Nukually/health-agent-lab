// 跨浏览器复制文本到剪贴板。
// iOS WebKit 的核心约束：
// 1. transient user activation 在第一个 await 后失效 —— 异步场景必须用
//    `navigator.clipboard.write([ClipboardItem])` 搭配 Promise<Blob>。
// 2. WKWebView（微信 iOS）对离屏 textarea 的 execCommand 会"骗人"返回 true
//    却不真正写入 —— legacy 路径必须把 textarea 放进视窗内。
import { clearDocumentSelection, scheduleSelectionCleanup } from './selection.js'

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      scheduleSelectionCleanup()
      return true
    } catch {
      // fall through to legacy
    }
  }
  // 进入 legacy 前先清掉上一次遗留的 selection，避免 iOS WKWebView
  // 把"脱离文档的旧 range"当作活跃选区，与新 textarea 的 range 叠加。
  clearDocumentSelection()
  const ok = legacyCopy(text)
  scheduleSelectionCleanup()
  return ok
}

// 异步场景专用：允许把 Promise<string> 传进来，在 user gesture 同步栈内
// 调用 navigator.clipboard.write —— iOS Safari 13.4+ 官方推荐的"懒剪贴板"。
// 调用方必须在 onClick 同步栈里直接传入 promise，不能先 await。
export async function copyTextLazy(textPromise: Promise<string>): Promise<boolean> {
  if (
    typeof ClipboardItem !== 'undefined' &&
    navigator.clipboard?.write &&
    window.isSecureContext
  ) {
    try {
      const blobPromise = textPromise.then(
        (t) => new Blob([t], { type: 'text/plain' })
      )
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': blobPromise }),
      ])
      scheduleSelectionCleanup()
      return true
    } catch {
      // 继续尝试降级（此时 user activation 已丢，基本只有非 iOS 环境能救）
    }
  }
  try {
    const text = await textPromise
    return await copyText(text)
  } catch {
    return false
  }
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  // iOS WKWebView 只对真正在视窗内的可编辑元素执行 execCommand('copy')。
  // 视觉上通过 transparent + 极小尺寸做到几乎不可见，但不用 opacity:0。
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.width = '2em'
  ta.style.height = '2em'
  ta.style.padding = '0'
  ta.style.margin = '0'
  ta.style.border = 'none'
  ta.style.outline = 'none'
  ta.style.boxShadow = 'none'
  ta.style.background = 'transparent'
  ta.style.color = 'transparent'
  ta.style.fontSize = '16px' // 阻止 iOS 聚焦自动放大
  document.body.appendChild(ta)

  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)
  if (isIOS) {
    // WKWebView 对 contentEditable + 非 readonly 的 textarea 配合更稳
    ta.contentEditable = 'true'
    ta.readOnly = false
    const range = document.createRange()
    range.selectNodeContents(ta)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    ta.setSelectionRange(0, text.length)
  } else {
    ta.select()
  }

  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    // 关键：必须在移除 textarea 之前显式清掉 selection。
    // 否则 range.anchorNode 指向脱离文档的节点，iOS WKWebView / 微信
    // 会把它当作活跃选区，叠加多次后系统选区层拦截整页 tap，
    // 表现为"所有按钮都点不动"，刷新才恢复。
    clearDocumentSelection()
    ta.blur()
    if (ta.parentNode) ta.parentNode.removeChild(ta)
  }
  return ok
}
