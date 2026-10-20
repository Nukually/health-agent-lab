/**
 * Conversation export — build Excel workbook from DB
 */

import ExcelJS from 'exceljs'
import { eq, and, gte, lte, asc } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { users, chatSessions, messages } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

interface ExportParams {
  phone?: string
  userId?: string
  startDate?: string
  endDate?: string
}

export async function exportConversations(params: ExportParams, logger: Logger) {
  const db = getDb()
  const start = performance.now()

  // Resolve target user(s)
  // If phone or userId provided → single user; otherwise → all users
  let targetUserId: string | undefined = params.userId

  if (params.phone && !targetUserId) {
    const user = await db.query.users.findFirst({
      where: eq(users.phone, params.phone),
    })
    if (!user) throw new Error(`user not found for phone: ${params.phone}`)
    targetUserId = user.id
  }

  // Build user lookup map: userId → { phone, nickname }
  const userMap = new Map<string, { phone: string; nickname: string | null }>()

  if (targetUserId) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, targetUserId),
    })
    if (!user) throw new Error(`user not found for id: ${targetUserId}`)
    userMap.set(user.id, { phone: user.phone, nickname: user.nickname })
  }

  // Build session filters
  const conditions: ReturnType<typeof eq>[] = []
  if (targetUserId) {
    conditions.push(eq(chatSessions.userId, targetUserId))
  }
  if (params.startDate) {
    conditions.push(gte(chatSessions.createdAt, new Date(params.startDate)))
  }
  if (params.endDate) {
    const end = new Date(params.endDate)
    end.setHours(23, 59, 59, 999)
    conditions.push(lte(chatSessions.createdAt, end))
  }

  const sessions = await db.query.chatSessions.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: asc(chatSessions.createdAt),
  })

  logger.info({ targetUserId: targetUserId || 'all', sessionCount: sessions.length }, 'export: sessions fetched')

  // Batch-load user info for all users mode
  if (!targetUserId && sessions.length > 0) {
    const userIds = [...new Set(sessions.map((s) => s.userId))]
    const allUsers = await db.query.users.findMany()
    for (const u of allUsers) {
      userMap.set(u.id, { phone: u.phone, nickname: u.nickname })
    }
  }

  // Build workbook
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('对话记录')

  ws.columns = [
    { header: '用户手机号', key: 'phone', width: 15 },
    { header: '用户昵称', key: 'nickname', width: 12 },
    { header: '会话ID', key: 'sessionId', width: 38 },
    { header: '会话标题', key: 'title', width: 25 },
    { header: '消息数', key: 'messageCount', width: 8 },
    { header: '创建时间', key: 'createdAt', width: 20 },
    { header: '最后更新', key: 'updatedAt', width: 20 },
    { header: '完整对话', key: 'conversation', width: 80 },
  ]

  ws.getRow(1).font = { bold: true }
  ws.getRow(1).alignment = { vertical: 'middle' }

  for (const session of sessions) {
    const userInfo = userMap.get(session.userId)

    const msgs = await db.query.messages.findMany({
      where: eq(messages.sessionId, session.id),
      orderBy: asc(messages.createdAt),
      columns: { role: true, content: true, thinking: true, createdAt: true },
    })

    const conversation = msgs.map((m) => {
      const lines: string[] = []
      const time = m.createdAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

      if (m.role === 'user') {
        lines.push(`[用户 ${time}] ${parseContent(m.content)}`)
      } else if (m.role === 'assistant') {
        if (m.thinking) lines.push(`[AI思考] ${m.thinking}`)
        lines.push(`[AI ${time}] ${m.content}`)
      } else {
        lines.push(`[系统] ${m.content}`)
      }

      return lines.join('\n')
    }).join('\n\n')

    ws.addRow({
      phone: userInfo?.phone || '',
      nickname: userInfo?.nickname || '',
      sessionId: session.id,
      title: session.title || '',
      messageCount: session.messageCount,
      createdAt: session.createdAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      updatedAt: session.updatedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      conversation,
    })
  }

  ws.getColumn('conversation').alignment = { wrapText: true, vertical: 'top' }

  logger.info(
    { targetUserId: targetUserId || 'all', sessionCount: sessions.length, exportMs: Math.round(performance.now() - start) },
    'export: workbook built',
  )

  return wb
}

/** Parse multimodal content back to plain text */
function parseContent(content: string): string {
  let text = content
  if (content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        const textPart = parsed.find((p: any) => p.type === 'text')
        text = textPart?.text || content
      }
    } catch { /* keep raw */ }
  }
  // strip 首部可能的 <system-reminder>...</system-reminder> 块
  return text.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '')
}
