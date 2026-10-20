/**
 * Title Generation — 自动对话标题
 *
 * 使用 qwen3.5-flash（关闭 thinking）生成中文标题
 * fire-and-forget 调用，不阻塞主聊天流程
 */

import { eq } from 'drizzle-orm'
import { llmCall } from '../lib/llm.js'
import { getDb } from '../db/client.js'
import { chatSessions } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

const TITLE_MODEL = 'qwen3.5-flash'

const TITLE_PROMPT = `根据用户的第一条消息，生成一个简洁的中文对话标题。

要求：
- 4-8个汉字
- 概括用户的核心意图
- 不加标点符号
- 只返回标题文本，不要任何其他内容

用户消息：`

export async function generateSessionTitle(
  userMessage: string,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  const start = performance.now()
  const log = logger.child({ module: 'title-gen', sessionId })

  try {
    const truncated = userMessage.length > 200 ? userMessage.slice(0, 200) : userMessage

    const response = await llmCall({
      model: TITLE_MODEL,
      messages: [{ role: 'user', content: TITLE_PROMPT + truncated }],
      max_tokens: 30,
      temperature: 0.3,
      enable_thinking: false,
    }, log)

    const title = response.choices?.[0]?.message?.content?.trim()
    if (!title || title.length > 50) {
      log.warn({ rawTitle: title }, 'title gen returned unusable result')
      return
    }

    const db = getDb()
    await db.update(chatSessions).set({ title }).where(eq(chatSessions.id, sessionId))

    log.info(
      { title, durationMs: Math.round(performance.now() - start) },
      'session title generated',
    )
  } catch (err: any) {
    log.warn({ error: err.message }, 'title generation failed (non-critical)')
  }
}
