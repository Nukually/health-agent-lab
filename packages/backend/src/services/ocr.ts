/**
 * OCR Service — 病历图片解析管线（单阶段视觉模型）
 *
 * 精简后：主模型（kimi-k2.5 多模态）一次调用直出 {isMedicalDocument, fields, meta, personalInfo}，
 * 不再产完整 OCR 转录文本。读取病历时由 agent 工具按需发原图给 LLM，避免转录错误传递。
 *
 * 图片存两份：原图 JPEG/PNG + base64 伴生对象（.b64）。
 * - 原图：前端展示、LLM 多模态 image_url（签名 URL）
 * - base64 伴生：saved_content 工具按需取，注入对话
 */

import { getModel } from '../state/process.js'
import { llmCall } from '../lib/llm.js'
import {
  uploadBuffer,
  uploadBase64,
  buildImageKey,
  buildBase64Key,
  getOSSClient,
  signUrl,
  deleteMedicalFileKeys,
} from '../lib/oss.js'
import { getImageAssetsForUser, getModelImageBlocksForAssetIds } from './image-asset.js'
import { createDocument } from './medical-document.js'
import {
  CURRENT_CONCERN_LABELS,
  TUMOR_TYPES,
  normalizeMedicalProfileData,
  normalizeTreatmentPhase,
  resolveOcrExtractableMedicalFields,
  type CurrentConcern,
  type MedicalProfileData,
  type DocumentMeta,
  type OcrResult,
  type ExtractedPersonalInfo,
} from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'

interface ExtractionContext {
  currentConcern: CurrentConcern | null | undefined
  gender?: string | null
}

// === 提取 prompt ===

function buildFieldSection(field: string, today: string): string {
  switch (field) {
    case 'menstrualStatus':
      return `### menstrualStatus — 月经状态
- premenopausal: 未绝经
- perimenopausal: 围绝经期
- postmenopausal: 已绝经
- treatment_induced: 治疗相关停经
- uncertain: 不确定`
    case 'tumorType':
      return `### tumorType — 肿瘤分型
- luminal_a: Luminal A 型
- luminal_b_her2_negative: Luminal B 型（HER2-）
- luminal_b_her2_positive: Luminal B 型（HER2+）
- her2_positive_hr_negative: HER2 阳性型（HR- / HER2+）
- triple_negative: 三阴性
- unknown_or_untested: 不清楚 / 未检测
注意：仅在报告原文明示分子分型/免疫组化分型/肿瘤分型时提取；不要只根据 ER/PR/HER2/Ki-67 等指标自行推断分型。报告未写明或看不清时返回 unknown_or_untested。`
    case 'noduleBiradsGrade':
      return `### noduleBiradsGrade — 乳腺检查分型
- birads_1_2: BI-RADS 1类或2类
- birads_3: BI-RADS 3类
- birads_4: BI-RADS 4类（含4A/4B/4C）
- birads_5: BI-RADS 5类
- uncertain: 不清楚/未检测
注意：仅在影像报告明确写有 BI-RADS/BI-RADS分类/分级时提取；报告写1类或2类都归 birads_1_2，写4A/4B/4C都归 birads_4；同一报告出现多个分级时取最高分级，冲突或看不清返回 uncertain。`
    case 'diagnosisDuration':
      return `### diagnosisDuration — 确诊时长（根据病历日期与当前日期 ${today} 推算）
- within_3m: 3个月内
- 3_to_6m: 3-6个月
- 6_to_12m: 6-12个月
- 1_to_3y: 1-3年
- over_3y: 3年以上`
    case 'treatmentPhase':
      return `### treatmentPhase — 治疗阶段
- pre_surgery: 手术前 / 等待手术
- surgery_recovery: 术后恢复中
- on_endocrine: 内分泌治疗中
- on_chemo: 化疗中
- on_radiation: 放疗中
- on_targeted: 靶向治疗中
- non_surgical_comprehensive: 未手术，正在综合治疗中
- phase_completed_waiting_next: 阶段性治疗已结束，等待下一步；病历只写化疗结束或放疗结束、且下一步治疗未明确时也归入此项
- completed_main: 主要治疗已完成，定期复查中
- paused_observation: 暂停治疗 / 观察中
- uncertain: 不确定`
    case 'medications':
      return `### medications — 用药情况（数组，可多选）
- tamoxifen: 他莫昔芬/TAM/三苯氧胺/枸橼酸他莫昔芬
- letrozole: 来曲唑/弗隆
- anastrozole: 阿那曲唑/瑞宁得
- exemestane: 依西美坦/阿诺新
- fulvestrant: 氟维司群/芙仕得
- other: 其他药物
- none: 未服用`
    case 'medicationDuration':
      return `### medicationDuration — 用药时长
- within_1m: 1个月内
- 1_to_3m: 1-3个月
- 3_to_6m: 3-6个月
- 6_to_12m: 6-12个月
- over_1y: 1年以上
- not_required: 无需填写（仅当 medications 为 none 时使用）`
    default:
      return ''
  }
}

function getShanghaiCurrentTime(now = new Date()): { date: string; text: string } {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  const date = `${pick('year')}-${pick('month')}-${pick('day')}`
  return { date, text: `${date} ${pick('hour')}:${pick('minute')} Asia/Shanghai` }
}

function buildExtractionPrompt(pageCount: number, context: ExtractionContext): string {
  const currentTime = getShanghaiCurrentTime()
  const multiPageHint =
    pageCount > 1
      ? `\n⚠️ 本次输入共 ${pageCount} 张图片，是同一份病历的多页。请综合所有图片内容后再输出，不要只看第一页。\n`
      : ''

  const allowedFields = resolveOcrExtractableMedicalFields(context.currentConcern, context.gender)
  const fieldSections = allowedFields
    .map((field) => buildFieldSection(field, currentTime.date))
    .filter(Boolean)
    .join('\n\n')
  const concernLabel = context.currentConcern
    ? CURRENT_CONCERN_LABELS[context.currentConcern]
    : '未设置'
  const fieldOutputLines = allowedFields.map((field) => {
    if (field === 'medications') return '"medications": []'
    return `"${field}": null`
  })
  if (allowedFields.includes('medications')) {
    fieldOutputLines.push('"medicationCustom": null')
  }

  return `你是一个医疗病历信息提取助手。任务是看懂病历图片，提取结构化信息。
${multiPageHint}
## 识别可靠性原则
- 先判断这些图片是否属于病历/医疗资料。分类要宽松：检查报告、影像/病理/检验报告、门诊/住院/出院记录、处方/用药单、随访记录、健康检查结果、医疗机构单据、患者手写整理的就诊相关资料，都应视为医疗资料。
- 只有在图片明显不是医疗资料时才拒绝，例如风景、自拍、宠物、餐食、普通生活随手拍、纯商品/票据/聊天截图等，且没有可辨认的医疗语境。
- 如果不确定、图片较模糊但仍像报告/病历/医院材料，或多张图片中至少一张明显是医疗资料，都按医疗资料处理。
- 当前时间锚点：${currentTime.text}。涉及诊断时长、用药时长、治疗阶段、报告新旧、"最近/既往/术后多久"等时间判断时，必须和这个当前时间对比；不要使用模型内置日期，也不要只凭报告模板或上传时间推断。
- 只提取图片中清晰可见、能可靠识别的内容；模糊、遮挡、反光、裁切不完整或手写体难以辨认的内容，不要猜测或补全。
- 不确定时返回 null / 对应字段的不确定枚举（如 unknown_or_untested 或 uncertain）/ []，不要为了填满字段而推断；不影响结构化字段的模糊内容可以直接省略。
- 病历原文中的数字、单位、阳性/阴性、结论或日期即使看起来异常、少见或与常识不一致，也不要擅自改成你认为正确的值。
- 若同一字段的原文信息彼此冲突，或指标与文字结论明显不一致，字段值返回对应字段的不确定枚举或 null；不要自行纠正成与病历原文冲突的结果。

你需要提取三部分内容：

## 一、文档元数据 (meta)
- documentDate: 就诊/检查/出院日期，格式 YYYY-MM-DD。如有多个日期取最主要的（如就诊日期优先于报告日期）
- title: 文档标题，如"门诊病历"、"病理报告"、"出院记录"、"MR诊断报告"等
- documentType: 文档类型，取值范围：outpatient(门诊)、pathology(病理)、imaging(影像)、discharge(出院)、lab(检验)、other
- hospital: 医院名称

## 二、个人基本信息 (personalInfo)
从病历中提取患者的基本信息，无法确定时返回 null：
- name: 姓名
- birthday: 出生日期，格式 YYYY-MM-DD。提取规则（按优先级）：
  1. 如果有身份证号（18位），从第7-14位提取：如 320721**19890619**3840 → 1989-06-19
  2. 如果有出生日期字段，直接使用
  3. 如果只有年龄（如"34岁"）和就诊日期（如 2024-02-22），用就诊日期减去年龄推算出生年份，日期设为 01-01
- gender: 性别，取值 "男" 或 "女"。提取规则：
  1. 如果有性别字段，直接使用
  2. 如果有身份证号（18位），第17位奇数为男、偶数为女

## 三、个人档案字段 (fields)
当前用户的“当前关注情况”是：${concernLabel}。
只提取下列允许字段；未列出的字段不要猜测，也不要输出：

${fieldSections}

## 输出格式
严格输出 JSON，不要有其他文字：

如果明显不是医疗资料，输出：
{
  "isMedicalDocument": false,
  "reason": "请上传病历、检查报告、出院记录、处方或用药单等医疗相关文件"
}

如果是医疗资料或不确定但像医疗资料，输出：
{
  "isMedicalDocument": true,
  "meta": { "documentDate": "...", "title": "...", "documentType": "...", "hospital": "..." },
  "personalInfo": { "name": "...", "birthday": "YYYY-MM-DD", "gender": "男/女" },
  "fields": { ${fieldOutputLines.join(', ')} }
}`
}

// === 核心函数 ===

/** base64 data URL → Buffer + content type */
function decodeBase64(dataUrl: string): { buffer: Buffer; contentType: string; ext: string; rawBase64: string } {
  const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
  if (!match) throw new Error('Invalid base64 data URL')
  return {
    buffer: Buffer.from(match[3], 'base64'),
    contentType: match[1],
    ext: match[2] === 'jpeg' ? 'jpg' : match[2],
    rawBase64: match[3],
  }
}

/**
 * 视觉模型一次调用直出 {isMedicalDocument, fields, meta, personalInfo}。
 * 不产 OCR 全文转录。入参为 OSS 签名 URL 数组（每页一张）。
 */
async function extractFieldsAndMeta(
  imageUrls: string[],
  context: ExtractionContext,
  logger: Logger,
): Promise<
  | { isMedicalDocument: true; fields: MedicalProfileData; meta: DocumentMeta; personalInfo: ExtractedPersonalInfo }
  | { isMedicalDocument: false; reason: string }
> {
  const model = getModel()
  const start = Date.now()

  const response = await llmCall(
    {
      model,
      messages: [
        { role: 'system', content: buildExtractionPrompt(imageUrls.length, context) },
        {
          role: 'user',
          content: [
            ...imageUrls.map((url) => ({
              type: 'image_url' as const,
              image_url: { url },
            })),
            { type: 'text', text: '请按系统提示输出 JSON。' },
          ],
        },
      ],
      temperature: 0.1,
      enable_thinking: false,
    },
    logger,
  )

  const raw = response.choices[0]?.message?.content || '{}'
  logger.info(
    {
      model,
      pageCount: imageUrls.length,
      durationMs: Date.now() - start,
      concern: context.currentConcern,
      gender: context.gender,
    },
    'vision field extraction completed',
  )

  // 解析 JSON —— 容错处理（LLM 可能包裹在 markdown 代码块中）
  let parsed: {
    isMedicalDocument?: boolean
    reason?: string
    fields?: MedicalProfileData
    meta?: DocumentMeta
    personalInfo?: ExtractedPersonalInfo
  }
  try {
    const jsonStr = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    parsed = JSON.parse(jsonStr)
  } catch {
    logger.warn({ rawLength: raw.length }, 'failed to parse extraction JSON, returning empty')
    parsed = {}
  }

  if (parsed.isMedicalDocument === false) {
    return {
      isMedicalDocument: false,
      reason: parsed.reason || '这张图片不像病历相关文件，请上传病历、检查报告、出院记录、处方或用药单等医疗资料。',
    }
  }

  const allowed = new Set(resolveOcrExtractableMedicalFields(context.currentConcern, context.gender))
  const fields: MedicalProfileData = {}
  const src = parsed.fields || {}
  if (allowed.has('menstrualStatus') && src.menstrualStatus) fields.menstrualStatus = src.menstrualStatus
  if (allowed.has('noduleBiradsGrade') && src.noduleBiradsGrade) fields.noduleBiradsGrade = src.noduleBiradsGrade
  if (allowed.has('tumorType') && src.tumorType && TUMOR_TYPES.includes(src.tumorType as any)) {
    fields.tumorType = src.tumorType
  }
  if (allowed.has('diagnosisDuration') && src.diagnosisDuration) fields.diagnosisDuration = src.diagnosisDuration
  if (allowed.has('treatmentPhase')) {
    const treatmentPhase = normalizeTreatmentPhase(src.treatmentPhase)
    if (treatmentPhase) fields.treatmentPhase = treatmentPhase
  }
  if (allowed.has('medications') && src.medications?.length) fields.medications = src.medications
  if (allowed.has('medications') && src.medicationCustom) fields.medicationCustom = src.medicationCustom
  if (allowed.has('medicationDuration') && src.medicationDuration) fields.medicationDuration = src.medicationDuration

  const meta: DocumentMeta = {
    documentDate: parsed.meta?.documentDate || null,
    title: parsed.meta?.title || null,
    documentType: parsed.meta?.documentType || null,
    hospital: parsed.meta?.hospital || null,
  }

  const personalInfo: ExtractedPersonalInfo = {}
  const pi = parsed.personalInfo || {}
  if (pi.name) personalInfo.name = pi.name
  if (pi.birthday) personalInfo.birthday = pi.birthday
  if (pi.gender === '男' || pi.gender === '女') personalInfo.gender = pi.gender

  return { isMedicalDocument: true, fields: normalizeMedicalProfileData(fields), meta, personalInfo }
}

// === 主入口 ===

/**
 * 完整 OCR 管线：
 *   1. 上传原图到 OSS（并行）→ 得到 OSS key
 *   2. 并行 {提取结构化字段（看签名 URL）+ 上传 base64 伴生对象}
 *   3. 写 DB（ocrText 置空、rawTextUrl 为 null、base64Urls 存伴生 key）
 */
export async function processOcrImages(
  userId: string,
  base64Images: string[],
  context: ExtractionContext,
  logger: Logger,
): Promise<OcrResult> {
  if (!getOSSClient()) throw new Error('OSS 文件存储服务未配置')

  // 1. 原图上传到 OSS（并行）
  logger.info({ imageCount: base64Images.length, concern: context.currentConcern }, 'uploading original images to OSS')
  const decoded = base64Images.map(decodeBase64)
  const imageKeys = await Promise.all(
    decoded.map(({ buffer, contentType, ext }) =>
      uploadBuffer(buildImageKey(userId, ext), buffer, contentType),
    ),
  )

  // 2. 并行：字段提取（用签名 URL 喂视觉模型）+ base64 伴生对象上传
  const signedUrls = imageKeys.map(signUrl)
  const extractPromise = extractFieldsAndMeta(signedUrls, context, logger)
  const base64UploadPromise = Promise.all(
    imageKeys.map((imageKey, i) =>
      uploadBase64(buildBase64Key(imageKey), decoded[i].rawBase64),
    ),
  )

  const [extraction, base64Keys] = await Promise.all([extractPromise, base64UploadPromise])
  if (!extraction.isMedicalDocument) {
    const deleteResult = await deleteMedicalFileKeys([...imageKeys, ...base64Keys])
    logger.info(
      { pageCount: imageKeys.length, deletedObjects: deleteResult.deleted, deleteErrors: deleteResult.errors.length },
      'OCR pipeline rejected obvious non-medical document images',
    )
    return extraction
  }

  const { fields, meta, personalInfo } = extraction

  // 3. 写数据库（ocrText 置空，不再产完整转录；base64Urls 存伴生 key）
  const document = await createDocument(
    userId,
    {
      ocrText: '',
      imageUrls: imageKeys,
      base64Urls: base64Keys,
      rawTextUrl: null,
      meta,
    },
    logger,
  )

  logger.info(
    { docId: document.id, title: meta.title, hospital: meta.hospital, pageCount: imageKeys.length },
    'OCR pipeline completed',
  )

  return {
    isMedicalDocument: true,
    document,
    extractedFields: fields,
    ...(Object.keys(personalInfo).length > 0 && { extractedPersonalInfo: personalInfo }),
  }
}

export async function processOcrImageAssets(
  userId: string,
  imageAssetIds: string[],
  context: ExtractionContext,
  logger: Logger,
): Promise<OcrResult> {
  const ossClient = getOSSClient()
  if (!ossClient) throw new Error('OSS 文件存储服务未配置')

  const assets = await getImageAssetsForUser(userId, imageAssetIds)
  if (assets.length !== imageAssetIds.length) {
    throw Object.assign(new Error('图片不存在或无权访问'), { status: 404 })
  }

  logger.info({ imageCount: assets.length, concern: context.currentConcern }, 'processing OCR image assets')
  const imageBlocks = await getModelImageBlocksForAssetIds(userId, imageAssetIds)
  const extraction = await extractFieldsAndMeta(
    imageBlocks.map((block) => block.image_url.url),
    context,
    logger,
  )
  if (!extraction.isMedicalDocument) return extraction

  const { fields, meta, personalInfo } = extraction
  const document = await createDocument(
    userId,
    {
      ocrText: '',
      imageUrls: assets.map((asset) => asset.originalKey),
      base64Urls: assets.map((asset) => buildBase64Key(asset.modelKey)),
      rawTextUrl: null,
      meta,
    },
    logger,
  )

  logger.info(
    { docId: document.id, title: meta.title, hospital: meta.hospital, pageCount: assets.length },
    'OCR pipeline completed from image assets',
  )

  return {
    isMedicalDocument: true,
    document,
    extractedFields: fields,
    ...(Object.keys(personalInfo).length > 0 && { extractedPersonalInfo: personalInfo }),
  }
}
