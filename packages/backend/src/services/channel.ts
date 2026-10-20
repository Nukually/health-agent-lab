import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import QRCode from 'qrcode'
import { getDb } from '../db/client.js'
import { channelAgents, channelPartners, channelQrCodes, users } from '../db/schema/index.js'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'
import type {
  ChannelAgent,
  ChannelPartner,
  ChannelQrCode,
  ChannelStatus,
  UserChannelSourceInfo,
} from '@health-agent/shared'
import { resolveChannelSourceTypeFromPartnerName } from '@health-agent/shared'

export interface ResolvedChannelAttribution {
  partnerId: string
  agentId: string
  qrCodeId: string
  channelCode: string
}

function toIso(value: Date): string {
  return value.toISOString()
}

function toPartner(row: typeof channelPartners.$inferSelect): ChannelPartner {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status as ChannelStatus,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function toAgent(row: typeof channelAgents.$inferSelect): ChannelAgent {
  return {
    id: row.id,
    partnerId: row.partnerId,
    code: row.code,
    name: row.name,
    status: row.status as ChannelStatus,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function toQrCode(row: typeof channelQrCodes.$inferSelect): ChannelQrCode {
  return {
    id: row.id,
    partnerId: row.partnerId,
    agentId: row.agentId,
    code: row.code,
    url: row.url,
    status: row.status as ChannelStatus,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function getChannelBaseUrl(): string {
  return getEnv().APP_BASE_URL
}

function buildChannelUrl(code: string): string {
  const base = getChannelBaseUrl()
  return `${base}?channelCode=${encodeURIComponent(code)}`
}

function generateChannelCode(): string {
  return `ch_${randomBytes(18).toString('base64url')}`
}

export async function upsertChannelPartner(input: {
  code: string
  name: string
  status: ChannelStatus
}): Promise<ChannelPartner> {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .insert(channelPartners)
    .values({
      code: input.code,
      name: input.name,
      status: input.status,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: channelPartners.code,
      set: {
        name: input.name,
        status: input.status,
        updatedAt: now,
      },
    })
    .returning()
  return toPartner(row)
}

export async function upsertChannelAgent(input: {
  partnerId: string
  code: string
  name: string
  status: ChannelStatus
}): Promise<ChannelAgent> {
  const db = getDb()
  const partner = await db.query.channelPartners.findFirst({
    where: eq(channelPartners.id, input.partnerId),
  })
  if (!partner) {
    const err = new Error('代理商不存在') as Error & { status?: number }
    err.status = 404
    throw err
  }

  const now = new Date()
  const [row] = await db
    .insert(channelAgents)
    .values({
      partnerId: input.partnerId,
      code: input.code,
      name: input.name,
      status: input.status,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [channelAgents.partnerId, channelAgents.code],
      set: {
        name: input.name,
        status: input.status,
        updatedAt: now,
      },
    })
    .returning()
  return toAgent(row)
}

export async function createChannelQrCodes(input: {
  partnerId: string
  agentId: string
  count: number
}, logger: Logger): Promise<ChannelQrCode[]> {
  const db = getDb()
  const agent = await db.query.channelAgents.findFirst({
    where: and(
      eq(channelAgents.id, input.agentId),
      eq(channelAgents.partnerId, input.partnerId),
    ),
  })
  if (!agent) {
    const err = new Error('代理员不存在或不属于该代理商') as Error & { status?: number }
    err.status = 404
    throw err
  }

  const rows: Array<typeof channelQrCodes.$inferInsert> = []
  for (let i = 0; i < input.count; i++) {
    const code = generateChannelCode()
    rows.push({
      partnerId: input.partnerId,
      agentId: input.agentId,
      code,
      url: buildChannelUrl(code),
      status: 'active',
    })
  }

  const inserted = await db.insert(channelQrCodes).values(rows).returning()
  logger.info({ partnerId: input.partnerId, agentId: input.agentId, count: inserted.length }, 'channel qr codes created')
  return inserted.map(toQrCode)
}

export async function resolveChannelAttribution(
  channelCode: string | null | undefined,
  logger: Logger,
): Promise<ResolvedChannelAttribution | null> {
  const code = channelCode?.trim()
  if (!code) return null

  const db = getDb()
  const rows = await db
    .select({
      qrCodeId: channelQrCodes.id,
      qrStatus: channelQrCodes.status,
      partnerId: channelPartners.id,
      partnerStatus: channelPartners.status,
      agentId: channelAgents.id,
      agentStatus: channelAgents.status,
    })
    .from(channelQrCodes)
    .innerJoin(channelPartners, eq(channelQrCodes.partnerId, channelPartners.id))
    .innerJoin(channelAgents, eq(channelQrCodes.agentId, channelAgents.id))
    .where(eq(channelQrCodes.code, code))
    .limit(1)

  const row = rows[0]
  if (!row) {
    logger.warn({ channelCode: code }, 'channel attribution ignored: code not found')
    return null
  }

  if (row.qrStatus !== 'active' || row.partnerStatus !== 'active' || row.agentStatus !== 'active') {
    logger.warn({
      channelCode: code,
      qrStatus: row.qrStatus,
      partnerStatus: row.partnerStatus,
      agentStatus: row.agentStatus,
    }, 'channel attribution ignored: inactive code hierarchy')
    return null
  }

  return {
    partnerId: row.partnerId,
    agentId: row.agentId,
    qrCodeId: row.qrCodeId,
    channelCode: code,
  }
}

export async function getUserChannelSourceInfo(userId: string): Promise<UserChannelSourceInfo> {
  const db = getDb()
  const rows = await db
    .select({
      partnerName: channelPartners.name,
    })
    .from(users)
    .leftJoin(channelPartners, eq(users.channelPartnerId, channelPartners.id))
    .where(eq(users.id, userId))
    .limit(1)

  const partnerName = rows[0]?.partnerName ?? null
  return {
    type: resolveChannelSourceTypeFromPartnerName(partnerName),
    channelPartnerName: partnerName,
  }
}

export async function exportChannelQrCodesWorkbook(logger: Logger): Promise<ExcelJS.Workbook> {
  const db = getDb()
  const rows = await db
    .select({
      partnerCode: channelPartners.code,
      partnerName: channelPartners.name,
      agentCode: channelAgents.code,
      agentName: channelAgents.name,
      qrCode: channelQrCodes.code,
      url: channelQrCodes.url,
      status: channelQrCodes.status,
      createdAt: channelQrCodes.createdAt,
    })
    .from(channelQrCodes)
    .innerJoin(channelPartners, eq(channelQrCodes.partnerId, channelPartners.id))
    .innerJoin(channelAgents, eq(channelQrCodes.agentId, channelAgents.id))

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('渠道二维码')

  ws.columns = [
    { header: '代理商编码', key: 'partnerCode', width: 18 },
    { header: '代理商名称', key: 'partnerName', width: 24 },
    { header: '代理员编码', key: 'agentCode', width: 18 },
    { header: '代理员名称', key: 'agentName', width: 24 },
    { header: '二维码Code', key: 'qrCode', width: 32 },
    { header: '入口链接', key: 'url', width: 58 },
    { header: '状态', key: 'status', width: 12 },
    { header: '创建时间', key: 'createdAt', width: 22 },
    { header: '二维码', key: 'qrImage', width: 20 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }

  for (const row of rows) {
    const excelRow = ws.addRow({
      ...row,
      createdAt: row.createdAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    })
    excelRow.height = 118
    excelRow.alignment = { vertical: 'middle', wrapText: true }
    const qrDataUrl = await QRCode.toDataURL(row.url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 140,
    })
    const imageId = wb.addImage({ base64: qrDataUrl, extension: 'png' })
    ws.addImage(imageId, {
      tl: { col: 8.15, row: excelRow.number - 0.85 },
      ext: { width: 100, height: 100 },
      editAs: 'oneCell',
    })
  }

  ws.getColumn('url').alignment = { wrapText: true, vertical: 'middle' }
  logger.info({ count: rows.length }, 'channel qr codes workbook built')
  return wb
}
